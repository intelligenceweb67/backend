require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const { GridFSBucket } = require('mongodb');
const { Readable } = require('stream');

const app = express();

// CORS configuration - allows both localhost and production frontend
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  process.env.FRONTEND_URL
].filter(Boolean); // Remove any undefined values

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    
    // Allow all origins if FRONTEND_URL is '*'
    if (process.env.FRONTEND_URL === '*') {
      return callback(null, true);
    }
    
    // Check if origin is in allowed list
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(null, true); // For development, allow all. Change to false in production.
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

let gfsBucket;

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ MongoDB Connected Successfully!");
    const db = mongoose.connection.db;
    gfsBucket = new GridFSBucket(db, {
      bucketName: "resumes",
    });
    console.log("📂 GridFS Bucket Ready!");
  })
  .catch(err => console.error("❌ MongoDB Connection Error:", err));

// Multer configuration
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed!'), false);
    }
  }
});

// Contact Schema
const contactSchema = new mongoose.Schema({
  name: { type: String, required: true },
  mobile: String,
  email: { type: String, required: true },
  subject: String,
  message: String,
  resumeFileId: mongoose.Schema.Types.ObjectId,
  resumeFileName: String,
  createdAt: { type: Date, default: Date.now }
});

const Contact = mongoose.model("Contact", contactSchema);

// POST - Submit contact form
app.post("/api/contact", upload.single("resume"), async (req, res) => {
  try {
    const { name, mobile, email, subject, message } = req.body;

    let fileId = null;
    let fileName = null;

    if (req.file) {
      const readableStream = new Readable();
      readableStream.push(req.file.buffer);
      readableStream.push(null);

      fileName = `resume_${Date.now()}_${req.file.originalname}`;

      const uploadStream = gfsBucket.openUploadStream(fileName, {
        contentType: "application/pdf",
      });

      fileId = uploadStream.id;

      await new Promise((resolve, reject) => {
        readableStream.pipe(uploadStream)
          .on('error', reject)
          .on('finish', resolve);
      });

      console.log(`✅ Resume uploaded with ID: ${fileId}`);
    }

    const newContact = new Contact({
      name,
      mobile,
      email,
      subject,
      message,
      resumeFileId: fileId,
      resumeFileName: fileName,
    });

    await newContact.save();

    res.json({
      success: true,
      message: "Contact and resume saved successfully!",
      data: {
        ...newContact.toObject(),
        resumeDownloadUrl: fileId ? `/api/resume/${fileId}` : null
      },
    });

  } catch (error) {
    console.error("❌ Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to save contact",
      error: error.message,
    });
  }
});

// GET - Download resume
app.get("/api/resume/:id", async (req, res) => {
  try {
    const fileId = new mongoose.Types.ObjectId(req.params.id);
    
    const files = await gfsBucket.find({ _id: fileId }).toArray();
    
    if (!files || files.length === 0) {
      return res.status(404).json({ error: "Resume not found" });
    }

    const file = files[0];
    
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${file.filename}"`,
    });

    const downloadStream = gfsBucket.openDownloadStream(fileId);
    
    downloadStream.on('error', (error) => {
      console.error("Download error:", error);
      res.status(500).json({ error: "Error downloading file" });
    });

    downloadStream.pipe(res);

  } catch (err) {
    console.error("❌ Error:", err);
    res.status(400).json({ error: "Invalid resume ID" });
  }
});

// GET - Fetch all contacts
app.get("/api/contacts", async (req, res) => {
  try {
    const contacts = await Contact.find().sort({ createdAt: -1 });
    res.json({
      success: true,
      data: contacts,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch contacts",
    });
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({ 
    status: "✅ Server is running!",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Start server (only for local development)
const PORT = process.env.PORT || 5000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 API available at http://localhost:${PORT}`);
  });
}

// Export for Vercel
module.exports = app;