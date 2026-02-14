require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const { GridFSBucket } = require("mongodb");
const { Readable } = require("stream");

const app = express();

// CORS configuration
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "https://int-elligence.co.uk",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (process.env.FRONTEND_URL === "*") {
        return callback(null, true);
      }
      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(null, true);
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json());

// ==========================================
// DATABASE CONNECTION - SERVERLESS OPTIMIZED
// ==========================================
let cachedDb = null;
let gfsBucket = null;

async function connectToDatabase() {
  if (cachedDb && gfsBucket) {
    console.log("♻️  Using cached database connection");
    return { db: cachedDb, gfsBucket };
  }

  try {
    console.log("🔄 Connecting to MongoDB...");
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    });
    
    cachedDb = conn.connection.db;
    gfsBucket = new GridFSBucket(cachedDb, {
      bucketName: "resumes",
    });
    
    console.log("✅ MongoDB Connected Successfully!");
    console.log("📂 GridFS Bucket Ready!");
    
    return { db: cachedDb, gfsBucket };
  } catch (err) {
    console.error("❌ MongoDB Connection Error:", err);
    throw err;
  }
}

// Multer configuration
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed!"), false);
    }
  },
});

// ==========================================
// SCHEMAS - Two Different Collections
// ==========================================

// Schema for Internship/Career inquiries (WITH resume)
const internshipContactSchema = new mongoose.Schema({
  name: { type: String, required: true },
  lastName: { type: String, required: true },
  mobile: { type: String, required: true },
  email: { type: String, required: true },
  resumeFileId: mongoose.Schema.Types.ObjectId,
  resumeFileName: String,
  createdAt: { type: Date, default: Date.now },
});

// Schema for General Contact (WITHOUT resume)
const generalContactSchema = new mongoose.Schema({
  name: { type: String, required: true },
  mobile: String,
  email: { type: String, required: true },
  subject: String,
  message: String,
  createdAt: { type: Date, default: Date.now },
});

const InternshipContact = mongoose.model(
  "InternshipContact",
  internshipContactSchema,
);
const GeneralContact = mongoose.model("GeneralContact", generalContactSchema);

// ==========================================
// ROUTES
// ==========================================

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "✅ Server is running!",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
  });
});

// POST - Submit INTERNSHIP form (with resume)
app.post(
  "/api/contact/internship",
  upload.single("resume"),
  async (req, res) => {
    try {
      // Connect to database first
      const { gfsBucket } = await connectToDatabase();

      const { name, lastName, mobile, email } = req.body;

      // Validation
      if (!name || !lastName || !email || !mobile) {
        return res.status(400).json({
          success: false,
          message: "All fields are required: name, lastName, email, and mobile",
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Resume file is required",
        });
      }

      let fileId = null;
      let fileName = null;

      // Upload resume to GridFS
      const readableStream = new Readable();
      readableStream.push(req.file.buffer);
      readableStream.push(null);

      fileName = `resume_${Date.now()}_${req.file.originalname}`;

      const uploadStream = gfsBucket.openUploadStream(fileName, {
        contentType: "application/pdf",
      });

      fileId = uploadStream.id;

      await new Promise((resolve, reject) => {
        readableStream
          .pipe(uploadStream)
          .on("error", reject)
          .on("finish", resolve);
      });

      console.log(`✅ Resume uploaded with ID: ${fileId}`);

      const newContact = new InternshipContact({
        name,
        lastName,
        mobile,
        email,
        resumeFileId: fileId,
        resumeFileName: fileName,
      });

      await newContact.save();

      res.json({
        success: true,
        message: "Internship application saved successfully!",
        data: {
          ...newContact.toObject(),
          resumeDownloadUrl: fileId ? `/api/resume/${fileId}` : null,
        },
      });
    } catch (error) {
      console.error("❌ Error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to save internship application",
        error: error.message,
      });
    }
  },
);

// POST - Submit GENERAL contact form (without resume)
app.post("/api/contact/general", async (req, res) => {
  try {
    // Connect to database first
    await connectToDatabase();

    const { name, mobile, email, subject, message } = req.body;

    // Validation
    if (!name || !email) {
      return res.status(400).json({
        success: false,
        message: "Name and email are required",
      });
    }

    const newContact = new GeneralContact({
      name,
      mobile,
      email,
      subject,
      message,
    });

    await newContact.save();

    res.json({
      success: true,
      message: "Message saved successfully!",
      data: newContact,
    });
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save message",
      error: error.message,
    });
  }
});

// GET - Download resume
app.get("/api/resume/:id", async (req, res) => {
  try {
    // Connect to database first
    const { gfsBucket } = await connectToDatabase();

    const fileId = new mongoose.Types.ObjectId(req.params.id);

    const files = await gfsBucket.find({ _id: fileId }).toArray();

    if (!files || files.length === 0) {
      return res.status(404).json({ error: "Resume not found" });
    }

    const file = files[0];

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${file.filename}"`,
    });

    const downloadStream = gfsBucket.openDownloadStream(fileId);

    downloadStream.on("error", (error) => {
      console.error("Download error:", error);
      res.status(500).json({ error: "Error downloading file" });
    });

    downloadStream.pipe(res);
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(400).json({ error: "Invalid resume ID" });
  }
});

// GET - Fetch all internship contacts
app.get("/api/contacts/internship", async (req, res) => {
  try {
    // Connect to database first
    await connectToDatabase();

    const contacts = await InternshipContact.find().sort({ createdAt: -1 });
    res.json({
      success: true,
      data: contacts,
    });
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch internship contacts",
    });
  }
});

// GET - Fetch all general contacts
app.get("/api/contacts/general", async (req, res) => {
  try {
    // Connect to database first
    await connectToDatabase();

    const contacts = await GeneralContact.find().sort({ createdAt: -1 });
    res.json({
      success: true,
      data: contacts,
    });
  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch general contacts",
    });
  }
});

// Export for Vercel serverless
module.exports = app;