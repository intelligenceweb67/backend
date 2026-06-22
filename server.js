
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors =require("cors");
const multer = require("multer");
const {GridFSBucket} = require("mongodb");
const {Readable} = require("stream");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();

// hashedPassword
const hashedPassword = process.env.ADMIN_PASSWORD ? bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10) : "";

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

            const isLocal = origin.startsWith("http://localhost") ||
                            origin.startsWith("http://127.0.0.1") ||
                            origin.startsWith("http://192.168.") ||
                            origin.startsWith("http://10.") ||
                            origin.startsWith("http://172.");

            if (isLocal || allowedOrigins.indexOf(origin) !== -1) {
                return callback(null, true);
            }

            if (process.env.FRONTEND_URL) {
                const cleanFrontend = process.env.FRONTEND_URL.replace(/^https?:\/\//i, "").split('/')[0];
                const cleanOrigin = origin.replace(/^https?:\/\//i, "").split('/')[0];
                
                if (cleanOrigin === cleanFrontend || cleanOrigin.endsWith("." + cleanFrontend)) {
                    return callback(null, true);
                }
            }

            callback(new Error("Not allowed by CORS"));
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
        console.log("T?  Using cached database connection");
        return {db: cachedDb, gfsBucket};
    }

    try {
        console.log("Y Connecting to MongoDB...");
        const conn = await mongoose.connect(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: 5000,
        });

        cachedDb = conn.connection.db;
        gfsBucket = new GridFSBucket(cachedDb, {
            bucketName: "resumes",
        });

        console.log("o. MongoDB Connected Successfully!");
        console.log("Y GridFS Bucket Ready!");

        return {db: cachedDb, gfsBucket};
    } catch (err) {
        console.error("?O MongoDB Connection Error:", err);
        throw err;
    }
}

// Multer configuration
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: {fileSize: 5 * 1024 * 1024},
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
    name: {type: String, required: true},
    lastName: {type: String, required: true},
    mobile: {type: String, required: true},
    email: {type: String, required: true},
    resumeFileId: mongoose.Schema.Types.ObjectId,
    resumeFileName: String,
    createdAt: {type: Date, default: Date.now},
});

// Schema for General Contact (WITHOUT resume)
const generalContactSchema = new mongoose.Schema({
    name: {type: String, required: true},
    mobile: String,
    email: {type: String, required: true},
    subject: String,
    message: String,
    createdAt: {type: Date, default: Date.now},
});

const InternshipContact = mongoose.model(
    "InternshipContact",
    internshipContactSchema,
);
const GeneralContact = mongoose.model("GeneralContact", generalContactSchema);

// Schema for Blogs
const blogSchema = new mongoose.Schema({
    title: {type: String, required: true},
    subtitle: {type: String},
    content: {type: String, required: true},
    category: {type: String, required: true},
    tags: [{type: String}],
    imageUrl: {type: String},
    readTime: {type: String},
    authorName: {type: String, default: "SkillBridge Team"},
    published: {type: Boolean, default: true},
    createdAt: {type: Date, default: Date.now},
});

const Blog = mongoose.model("Blog", blogSchema);

// ==========================================
// ROUTES
// ==========================================

// Health check
app.get("/", (req, res) => {
    res.json({
        status: "o. Server is running!",
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || "development",
    });
});
//================================================
//Login
//================================================
app.post("/api/auth/login", (req, res) => {
    const {username, password} = req.body;

    if (username === process.env.ADMIN_USERNAME && bcrypt.compareSync(password, hashedPassword)) {
        const token = jwt.sign({username}, process.env.JWT_SECRET, {expiresIn: "1h"});
        const isLocal = req.headers.host && (
            req.headers.host.includes('localhost') || 
            req.headers.host.includes('127.0.0.1') || 
            req.headers.host.startsWith('192.168.') || 
            req.headers.host.startsWith('10.') || 
            req.headers.host.startsWith('172.')
        );
        res.cookie('token', token, {
            httpOnly: true,
            secure: !isLocal && process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 3600000 // 1 hour
        });
        res.json({success: true});
    } else {
        res.status(401).json({message: "Invalid credentials"});
    }
});

app.post("/api/auth/logout", (req, res) => {
    const isLocal = req.headers.host && (
        req.headers.host.includes('localhost') || 
        req.headers.host.includes('127.0.0.1') || 
        req.headers.host.startsWith('192.168.') || 
        req.headers.host.startsWith('10.') || 
        req.headers.host.startsWith('172.')
    );
    res.clearCookie('token', {
        httpOnly: true,
        secure: !isLocal && process.env.NODE_ENV === 'production',
        sameSite: 'strict'
    });
    res.json({success: true});
});

const verifyToken = (req, res, next) => {
    const cookieHeader = req.headers.cookie || "";
    const cookies = Object.fromEntries(
        cookieHeader.split(";").map(c => {
            const index = c.indexOf("=");
            if (index === -1) return [c.trim(), ""];
            return [c.substring(0, index).trim(), c.substring(index + 1)];
        })
    );
    const token = cookies.token;

    if (!token) {
        return res.status(403).json({message: "A token is required for authentication"});
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
    } catch (err) {
        return res.status(401).json({message: "Invalid Token"});
    }

    return next();
};
// POST - Submit INTERNSHIP form (with resume)
app.post(
    "/api/contact/internship",
    upload.single("resume"),
    async (req, res) => {
        try {
            // Connect to database first
            const {gfsBucket} = await connectToDatabase();

            const {name, lastName, mobile, email} = req.body;

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

            console.log(`o. Resume uploaded with ID: ${fileId}`);

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
            console.error("?O Error:", error);
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

        const {name, mobile, email, subject, message} = req.body;

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
        console.error("?O Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to save message",
            error: error.message,
        });
    }
});

// GET - Download resume
app.get("/api/resume/:id",verifyToken, async (req, res) => {
    try {
        // Connect to database first
        const {gfsBucket} = await connectToDatabase();

        const fileId = new mongoose.Types.ObjectId(req.params.id);

        const files = await gfsBucket.find({_id: fileId}).toArray();

        if (!files || files.length === 0) {
            return res.status(404).json({error: "Resume not found"});
        }

        const file = files[0];

        res.set({
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="${file.filename}"`,
        });

        const downloadStream = gfsBucket.openDownloadStream(fileId);

        downloadStream.on("error", (error) => {
            console.error("Download error:", error);
            res.status(500).json({error: "Error downloading file"});
        });

        downloadStream.pipe(res);
    } catch (err) {
        console.error("?O Error:", err);
        res.status(400).json({error: "Invalid resume ID"});
    }
});

// GET - Fetch all internship contacts
app.get("/api/contacts/internship", verifyToken, async (req, res) => {
    try {
        // Connect to database first
        await connectToDatabase();

        const contacts = await InternshipContact.find().sort({createdAt: -1});
        res.json({
            success: true,
            data: contacts,
        });
    } catch (error) {
        console.error("?O Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch internship contacts",
        });
    }
});

// GET - Fetch all general contacts
app.get("/api/contacts/general", verifyToken, async (req, res) => {
    try {
        // Connect to database first
        await connectToDatabase();

        const contacts = await GeneralContact.find().sort({createdAt: -1});
        res.json({
            success: true,
            data: contacts,
        });
    } catch (error) {
        console.error("?O Error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch general contacts",
        });
    }
});

// ==========================================
// BLOG API ROUTES
// ==========================================

// GET - Fetch all blogs (supports category, search, and includeUnpublished query params)
app.get("/api/blogs", async (req, res) => {
    try {
        await connectToDatabase();
        const { category, search, includeUnpublished } = req.query;
        
        let query = {};
        
        // By default, only return published posts unless explicitly requested (for admin views)
        if (includeUnpublished !== "true") {
            query.published = true;
        }
        
        if (category && category !== "All") {
            query.category = category;
        }
        
        if (search) {
            query.$or = [
                { title: { $regex: search, $options: "i" } },
                { subtitle: { $regex: search, $options: "i" } },
                { content: { $regex: search, $options: "i" } }
            ];
        }
        
        const blogs = await Blog.find(query).sort({ createdAt: -1 });
        res.json({ success: true, data: blogs });
    } catch (error) {
        console.error("Error fetching blogs:", error);
        res.status(500).json({ success: false, message: "Failed to fetch blogs" });
    }
});

// GET - Fetch single blog by ID
app.get("/api/blogs/:id", async (req, res) => {
    try {
        await connectToDatabase();
        const blog = await Blog.findById(req.params.id);
        if (!blog) {
            return res.status(404).json({ success: false, message: "Blog not found" });
        }
        res.json({ success: true, data: blog });
    } catch (error) {
        console.error("Error fetching blog details:", error);
        res.status(400).json({ success: false, message: "Invalid blog ID or error retrieving blog" });
    }
});

// POST - Create new blog (admin only)
app.post("/api/blogs", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        const { title, subtitle, content, category, tags, imageUrl, readTime, authorName, published } = req.body;
        
        if (!title || !content || !category) {
            return res.status(400).json({ success: false, message: "Title, content, and category are required fields." });
        }
        
        const newBlog = new Blog({
            title,
            subtitle,
            content,
            category,
            tags: Array.isArray(tags) ? tags : (tags ? tags.split(",").map(t => t.trim()) : []),
            imageUrl,
            readTime,
            authorName: authorName || "SkillBridge Team",
            published: published !== undefined ? published : true,
        });
        
        await newBlog.save();
        res.json({ success: true, message: "Blog created successfully!", data: newBlog });
    } catch (error) {
        console.error("Error creating blog:", error);
        res.status(500).json({ success: false, message: "Failed to create blog", error: error.message });
    }
});

// PUT - Update an existing blog (admin only)
app.put("/api/blogs/:id", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        const { title, subtitle, content, category, tags, imageUrl, readTime, authorName, published } = req.body;
        
        if (!title || !content || !category) {
            return res.status(400).json({ success: false, message: "Title, content, and category are required fields." });
        }
        
        const parsedTags = Array.isArray(tags) ? tags : (tags ? tags.split(",").map(t => t.trim()) : []);
        
        const updatedBlog = await Blog.findByIdAndUpdate(
            req.params.id,
            {
                title,
                subtitle,
                content,
                category,
                tags: parsedTags,
                imageUrl,
                readTime,
                authorName: authorName || "SkillBridge Team",
                published: published !== undefined ? published : true,
            },
            { new: true }
        );
        
        if (!updatedBlog) {
            return res.status(404).json({ success: false, message: "Blog not found" });
        }
        
        res.json({ success: true, message: "Blog updated successfully!", data: updatedBlog });
    } catch (error) {
        console.error("Error updating blog:", error);
        res.status(500).json({ success: false, message: "Failed to update blog", error: error.message });
    }
});

// DELETE - Delete a blog (admin only)
app.delete("/api/blogs/:id", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        const deletedBlog = await Blog.findByIdAndDelete(req.params.id);
        
        if (!deletedBlog) {
            return res.status(404).json({ success: false, message: "Blog not found" });
        }
        
        res.json({ success: true, message: "Blog deleted successfully!" });
    } catch (error) {
        console.error("Error deleting blog:", error);
        res.status(500).json({ success: false, message: "Failed to delete blog" });
    }
});

// Global error handling middleware
app.use((err, req, res, next) => {
    console.error("Global error handler caught:", err);
    if (err.name === "MulterError" || err instanceof multer.MulterError || (err.code && err.code.startsWith("LIMIT_"))) {
        return res.status(400).json({
            success: false,
            message: err.code === "LIMIT_FILE_SIZE" ? "File size limit exceeded (max 5MB)" : err.message
        });
    }
    if (err.message === "Only PDF files are allowed!") {
        return res.status(400).json({
            success: false,
            message: err.message
        });
    }
    res.status(err.status || 500).json({
        success: false,
        message: err.message || "Internal Server Error"
    });
});

// If this file is run directly (node server.js) start a local server.
// When used as a serverless handler (e.g. Vercel), it will just export the app.
if (require.main === module) {
    const port = process.env.PORT || 5000;
    connectToDatabase()
        .then(() => {
            app.listen(port, () => {
                console.log(`Ys? Server listening on http://localhost:${port}`);
            });
        })
        .catch((err) => {
            console.error('Failed to connect to database, server not started', err);
            process.exit(1);
        });
}

// Export for Vercel serverless or other runners
module.exports = app;
