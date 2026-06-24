const dns = require("dns");
try {
    dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (e) {
    console.warn("Failed to set custom DNS servers, using system default:", e);
}

require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors =require("cors");
const multer = require("multer");
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

            // Fallback rule to automatically allow Cloudflare Pages staging subdomains
            const cleanOrigin = origin.replace(/^https?:\/\//i, "").split('/')[0];
            const isStagingPagesDev = cleanOrigin === "skillbridge-d8a.pages.dev" || cleanOrigin.endsWith(".skillbridge-d8a.pages.dev");

            if (isLocal || isStagingPagesDev || allowedOrigins.indexOf(origin) !== -1) {
                return callback(null, true);
            }

            if (process.env.FRONTEND_URL) {
                let cleanFrontend = process.env.FRONTEND_URL.replace(/^https?:\/\//i, "").split('/')[0];
                const cleanOrigin = origin.replace(/^https?:\/\//i, "").split('/')[0];
                
                // Extract base domain to strip prefixes like "staging." or "www."
                const parts = cleanFrontend.split(".");
                let baseDomain = cleanFrontend;
                if (parts.length > 2) {
                    if (cleanFrontend.endsWith(".pages.dev") && parts.length > 3) {
                        baseDomain = parts.slice(-3).join(".");
                    } else if (!cleanFrontend.endsWith(".pages.dev")) {
                        const isCoUk = cleanFrontend.endsWith(".co.uk") || cleanFrontend.endsWith(".org.uk");
                        baseDomain = parts.slice(isCoUk ? -3 : -2).join(".");
                    }
                }
                
                if (cleanOrigin === baseDomain || cleanOrigin.endsWith("." + baseDomain) || 
                    cleanOrigin === cleanFrontend || cleanOrigin.endsWith("." + cleanFrontend)) {
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
// DATABASE CONNECTION - MODULARIZED
// ==========================================
const { connectToDatabase, getGfsBucket } = require("./connection");

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

const imageUpload = multer({
    storage,
    limits: {fileSize: 2 * 1024 * 1024}, // 2MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = ["image/png", "image/jpeg", "image/jpg", "image/svg+xml", "image/webp", "image/gif"];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Only image files are allowed (png, jpg, jpeg, svg, webp, gif)!"), false);
        }
    },
});

// Multer config for video uploads (50MB, common video types)
const videoUpload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = ["video/mp4", "video/webm", "video/ogg", "video/quicktime", "video/x-msvideo"];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Only video files are allowed (mp4, webm, ogg, mov, avi)!"), false);
        }
    },
});

// ==========================================
// SCHEMAS & MODELS - MODULARIZED
// ==========================================
const { InternshipContact, GeneralContact, Blog, Course, Review, VideoTestimonial } = require("./schema");

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
            secure: !isLocal,
            sameSite: isLocal ? 'strict' : 'none',
            maxAge: 3600000 // 1 hour
        });
        res.json({success: true, token});
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
        secure: !isLocal,
        sameSite: isLocal ? 'strict' : 'none'
    });
    res.json({success: true});
});

const verifyToken = (req, res, next) => {
    let token = null;

    // 1. Check cookies
    const cookieHeader = req.headers.cookie || "";
    const cookies = Object.fromEntries(
        cookieHeader.split(";").map(c => {
            const index = c.indexOf("=");
            if (index === -1) return [c.trim(), ""];
            return [c.substring(0, index).trim(), c.substring(index + 1)];
        })
    );
    if (cookies.token) {
        token = cookies.token;
    }

    // 2. Check Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
        token = authHeader.substring(7);
    }

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

            const {name, lastName, mobile, email, program} = req.body;

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
                program,
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

// GET - Fetch all internship contacts (supports pagination, search, and date filters)
app.get("/api/contacts/internship", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        
        let { page, limit, search, startDate, endDate } = req.query;
        page = parseInt(page) || 1;
        limit = parseInt(limit) || 10;
        const skip = (page - 1) * limit;
        
        let query = {};
        
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: "i" } },
                { lastName: { $regex: search, $options: "i" } },
                { email: { $regex: search, $options: "i" } }
            ];
        }
        
        if (startDate || endDate) {
            query.createdAt = {};
            if (startDate) {
                query.createdAt.$gte = new Date(startDate);
            }
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                query.createdAt.$lte = end;
            }
        }
        
        const total = await InternshipContact.countDocuments(query);
        const contacts = await InternshipContact.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);
            
        res.json({
            success: true,
            data: contacts,
            pagination: {
                total,
                page,
                pages: Math.ceil(total / limit),
                limit
            }
        });
    } catch (error) {
        console.error("Error fetching internship contacts:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch internship contacts",
        });
    }
});

// GET - Fetch all general contacts (supports pagination, search, and date filters)
app.get("/api/contacts/general", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        
        let { page, limit, search, startDate, endDate } = req.query;
        page = parseInt(page) || 1;
        limit = parseInt(limit) || 10;
        const skip = (page - 1) * limit;
        
        let query = {};
        
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: "i" } },
                { email: { $regex: search, $options: "i" } }
            ];
        }
        
        if (startDate || endDate) {
            query.createdAt = {};
            if (startDate) {
                query.createdAt.$gte = new Date(startDate);
            }
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                query.createdAt.$lte = end;
            }
        }
        
        const total = await GeneralContact.countDocuments(query);
        const contacts = await GeneralContact.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);
            
        res.json({
            success: true,
            data: contacts,
            pagination: {
                total,
                page,
                pages: Math.ceil(total / limit),
                limit
            }
        });
    } catch (error) {
        console.error("Error fetching general contacts:", error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch general contacts",
        });
    }
});

// DELETE - Delete general contact (admin only)
app.delete("/api/contacts/general/:id", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        const contact = await GeneralContact.findByIdAndDelete(req.params.id);
        if (!contact) {
            return res.status(404).json({ success: false, message: "Contact not found" });
        }
        res.json({ success: true, message: "General contact deleted successfully" });
    } catch (error) {
        console.error("Error deleting general contact:", error);
        res.status(500).json({ success: false, message: "Failed to delete general contact" });
    }
});

// DELETE - Delete internship contact and associated GridFS resume (admin only)
app.delete("/api/contacts/internship/:id", verifyToken, async (req, res) => {
    try {
        const { gfsBucket } = await connectToDatabase();
        const contact = await InternshipContact.findById(req.params.id);
        
        if (!contact) {
            return res.status(404).json({ success: false, message: "Contact not found" });
        }
        
        if (contact.resumeFileId) {
            try {
                await gfsBucket.delete(contact.resumeFileId);
                console.log(`Successfully deleted GridFS resume ${contact.resumeFileId}`);
            } catch (fileErr) {
                console.error("Failed to delete GridFS file (it might have been deleted already):", fileErr);
            }
        }
        
        await InternshipContact.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: "Internship application deleted successfully" });
    } catch (error) {
        console.error("Error deleting internship contact:", error);
        res.status(500).json({ success: false, message: "Failed to delete internship application" });
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

// ==========================================
// COURSES API
// ==========================================
// IMPORTANT: Route ordering matters in Express!
// Specific routes (e.g. /admin/all, /id/:id, /tool-image/:id) MUST be declared
// BEFORE the generic wildcard route /:slug to prevent incorrect matching.

// GET - List all published courses (public, ordered by 'order' field)
app.get("/api/courses", async (req, res) => {
    try {
        await connectToDatabase();
        const courses = await Course.find({ published: true })
            .sort({ order: 1, createdAt: 1 })
            .select("slug title shortTitle cardDescription cardImage hero.headline hero.statistics programHighlights.duration published order");
        res.json({ success: true, data: courses });
    } catch (error) {
        console.error("Error fetching courses:", error);
        res.status(500).json({ success: false, message: "Failed to fetch courses" });
    }
});

// GET - List ALL courses including unpublished (admin only)
// Must be before /:slug to avoid route conflict
app.get("/api/courses/admin/all", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        const courses = await Course.find({})
            .sort({ order: 1, createdAt: 1 })
            .select("slug title shortTitle published order createdAt");
        res.json({ success: true, data: courses });
    } catch (error) {
        console.error("Error fetching all courses:", error);
        res.status(500).json({ success: false, message: "Failed to fetch courses" });
    }
});

// GET - Fetch single course by MongoDB _id (admin edit form)
// Must be before /:slug to avoid route conflict
app.get("/api/courses/id/:id", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        const course = await Course.findById(req.params.id);
        if (!course) {
            return res.status(404).json({ success: false, message: "Course not found" });
        }
        res.json({ success: true, data: course });
    } catch (error) {
        console.error("Error fetching course by id:", error);
        res.status(400).json({ success: false, message: "Invalid ID or error retrieving course" });
    }
});

// GET - Serve tool image/logo from GridFS (public)
// Must be before /:slug to avoid route conflict — 'tool-image' would otherwise match as a slug
app.get("/api/courses/tool-image/:id", async (req, res) => {
    try {
        const { gfsBucket } = await connectToDatabase();
        const fileId = new mongoose.Types.ObjectId(req.params.id);
        const files = await gfsBucket.find({ _id: fileId }).toArray();

        if (!files || files.length === 0) {
            return res.status(404).json({ success: false, message: "Image not found" });
        }

        const file = files[0];

        res.set({
            "Content-Type": file.contentType || "image/png",
            "Cache-Control": "public, max-age=31536000",
        });

        const downloadStream = gfsBucket.openDownloadStream(fileId);

        downloadStream.on("error", (error) => {
            console.error("Tool image serving error:", error);
            res.status(500).json({ success: false, message: "Error downloading file" });
        });

        downloadStream.pipe(res);
    } catch (err) {
        console.error("Error serving tool image:", err);
        res.status(400).json({ success: false, message: "Invalid image ID" });
    }
});

// GET - Fetch single course by slug (public — used by InternshipDetailPage)
// MUST come AFTER all specific /api/courses/XXX routes above
app.get("/api/courses/:slug", async (req, res) => {
    try {
        await connectToDatabase();
        const course = await Course.findOne({ slug: req.params.slug, published: true });
        if (!course) {
            return res.status(404).json({ success: false, message: "Course not found" });
        }
        res.json({ success: true, data: course });
    } catch (error) {
        console.error("Error fetching course:", error);
        res.status(500).json({ success: false, message: "Failed to fetch course" });
    }
});

// PUT - Update a course by _id (admin only)
app.put("/api/courses/:id", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        const existing = await Course.findById(req.params.id);
        if (!existing) {
            return res.status(404).json({ success: false, message: "Course not found" });
        }

        const slug = req.body.slug !== undefined ? req.body.slug : existing.slug;
        const title = req.body.title !== undefined ? req.body.title : existing.title;

        if (!slug || !title) {
            return res.status(400).json({ success: false, message: "slug and title are required" });
        }

        const updatedCourse = await Course.findByIdAndUpdate(
            req.params.id,
            { ...req.body },
            { new: true, runValidators: true }
        );
        res.json({ success: true, message: "Course updated successfully!", data: updatedCourse });
    } catch (error) {
        console.error("Error updating course:", error);
        res.status(500).json({ success: false, message: "Failed to update course", error: error.message });
    }
});

// DELETE - Delete a course by _id (admin only)
app.delete("/api/courses/:id", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        const deleted = await Course.findByIdAndDelete(req.params.id);
        if (!deleted) {
            return res.status(404).json({ success: false, message: "Course not found" });
        }
        res.json({ success: true, message: "Course deleted successfully!" });
    } catch (error) {
        console.error("Error deleting course:", error);
        res.status(500).json({ success: false, message: "Failed to delete course" });
    }
});

// POST - Upload tool image/logo to GridFS (admin only)
// Must be before POST /api/courses to avoid any potential conflicts
app.post("/api/courses/upload-tool-logo", verifyToken, (req, res, next) => {
    imageUpload.single("image")(req, res, (err) => {
        if (err) {
            return next(err);
        }
        next();
    });
}, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: "Image file is required" });
        }

        const { gfsBucket } = await connectToDatabase();
        const fileName = `tool_logo_${Date.now()}_${req.file.originalname}`;
        const uploadStream = gfsBucket.openUploadStream(fileName, {
            contentType: req.file.mimetype,
        });

        const fileId = uploadStream.id;

        await new Promise((resolve, reject) => {
            const stream = require("stream");
            const bufferStream = new stream.PassThrough();
            bufferStream.end(req.file.buffer);
            bufferStream
                .pipe(uploadStream)
                .on("error", reject)
                .on("finish", resolve);
        });

        console.log(`Successfully uploaded tool logo to GridFS with ID: ${fileId}`);

        res.json({
            success: true,
            message: "Logo uploaded successfully!",
            url: `/api/courses/tool-image/${fileId}`,
        });
    } catch (error) {
        console.error("Error uploading tool logo:", error);
        res.status(500).json({ success: false, message: "Failed to upload logo", error: error.message });
    }
});

// POST - Seed courses in bulk (admin only, idempotent via slug upsert)
// IMPORTANT: This route MUST come before POST /api/courses to match before the generic handler.
// Used once to migrate the 5 existing static course files into MongoDB.
app.post("/api/courses/seed", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        const courses = req.body; // Expect array of course objects
        if (!Array.isArray(courses) || courses.length === 0) {
            return res.status(400).json({ success: false, message: "Request body must be a non-empty array of course objects" });
        }
        const results = [];
        for (const courseData of courses) {
            if (!courseData.slug) continue;
            const result = await Course.findOneAndUpdate(
                { slug: courseData.slug },
                { $set: courseData },
                { upsert: true, new: true, runValidators: true }
            );
            results.push({ slug: courseData.slug, id: result._id });
        }
        res.json({ success: true, message: `${results.length} courses seeded successfully`, data: results });
    } catch (error) {
        console.error("Error seeding courses:", error);
        res.status(500).json({ success: false, message: "Failed to seed courses", error: error.message });
    }
});

// POST - Create new course (admin only)
app.post("/api/courses", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        const { slug } = req.body;
        if (!slug || !req.body.title) {
            return res.status(400).json({ success: false, message: "slug and title are required" });
        }
        // Check slug uniqueness
        const existing = await Course.findOne({ slug });
        if (existing) {
            return res.status(409).json({ success: false, message: `A course with slug "${slug}" already exists` });
        }
        const newCourse = new Course(req.body);
        await newCourse.save();
        res.json({ success: true, message: "Course created successfully!", data: newCourse });
    } catch (error) {
        console.error("Error creating course:", error);
        res.status(500).json({ success: false, message: "Failed to create course", error: error.message });
    }
});

// ==========================================
// COURSE IMAGES & GOOGLE REVIEWS ENDPOINTS
// ==========================================

// Helper for https requests to Google Places
const https = require("https");
function fetchGoogleReviews(placeId, apiKey) {
    return new Promise((resolve, reject) => {
        const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=reviews&key=${apiKey}`;
        https.get(url, (res) => {
            let data = "";
            res.on("data", (chunk) => data += chunk);
            res.on("end", () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.status === "OK") {
                        resolve(parsed.result.reviews || []);
                    } else {
                        reject(new Error(`Google API returned status ${parsed.status}: ${parsed.error_message || ''}`));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        }).on("error", reject);
    });
}

const fallbackReviews = [
  {
    id: 1,
    name: "Joshua Olatunbosun",
    quote: "Training was delivered in an interesting and simple way. It was quite insightful.",
    link: "https://share.google/APzhEBCyPtCkALx8m"
  },
  {
    id: 2,
    name: "Christen Sattouf",
    quote: "The course was very valuable and enjoyable. We learned everything related to machine learning and deep learning, including how to use each model and when to apply it. Weekly meetings with the instructor for feedback and discussions were extremely helpful. The final projects made the concepts practical and fun.",
    link: "https://share.google/Lhnwp46VRQFZGNRH4"
  },
  {
    id: 3,
    name: "Oladele Fagbayi",
    quote: "It's a wonderful experience I had with IntElligence Tech Solutions, especially in Machine Learning and Deep Learning. I was exposed to real-time applications like predictive forex apps, movie recommendation systems, and agentic AI. I am deeply grateful to Mohammed Noman, Salman Amin, and the entire team.",
    link: "https://maps.app.goo.gl/sB8QmEoECDqXKcnL9"
  },
  {
    id: 4,
    name: "Emily Willey",
    quote: "Absolutely brilliant experience with IntElligence Tech Solutions! The hands-on projects gave me real-world skills straight away. The mentors were incredibly supportive, and the program was well-structured and industry-relevant. Highly recommend to anyone in the UK looking to break into data science!",
    link: "https://maps.app.goo.gl/16LFn2XkF7WhhnaZ7"
  },
  {
    id: 5,
    name: "Emils Bahanovskis",
    quote: "Great programme, learned a great deal, and very personable people! Weekly calls with an instructor ensured frequent feedback and rapid improvement.",
    link: "https://maps.app.goo.gl/5PnEyT3GxunTAhmk6"
  },
  {
    id: 6,
    name: "Richard Trescothick",
    quote: "Every module felt meaningful and connected to real outcomes, not just classroom work. The guidance and support were sincere, making the entire process rewarding.",
    link: ""
  },
  {
    id: 7,
    name: "Killian Higgins",
    quote: "In addition to being incredibly informative and well presented, the staff and teachers were helpful and understanding at every step. I walked away having learned a lot and would recommend it to anyone.",
    link: "https://maps.app.goo.gl/sjZRb8ptTw1EcJrJ8"
  },
  {
    id: 8,
    name: "Valarmathi Sri",
    quote: "I had a truly enriching experience during my Data Science internship. I built a full trading bot using LSTM models with measurable performance gains. Special thanks to my mentor Mohammed Noman for his patience, guidance, and encouragement.",
    link: "https://maps.app.goo.gl/W2sWr8Qp8Q69qGMKA"
  },
  {
    id: 9,
    name: "George Cunningham",
    quote: "Enrolling in the Data Science training and internship certificate program was career-changing. It transformed my understanding of real-world data science far beyond university learning. Highly recommended for anyone in the UK.",
    link: "https://maps.app.goo.gl/a59iJmpka7fRNLCP6"
  },
  {
    id: 10,
    name: "Obanla Oluwaseun",
    quote: "My internship training was a real eye-opener into professional data science. Mr. Noman broke down complex concepts clearly and prioritized industry-relevant skills. The projects truly make you employable.",
    link: "https://maps.app.goo.gl/wt12AGcUs9hGCPnf6"
  }
];

// ==========================================
// REVIEWS API (Admin-managed + fallback)
// ==========================================

// GET - Fetch published reviews (public)
// Optional ?page= filter: "homepage", "data-science", etc.
// Empty pages[] on a review = show everywhere (backwards compat).
app.get("/api/reviews", async (req, res) => {
    try {
        await connectToDatabase();
        const { page } = req.query;
        let query = { published: true };
        if (page) {
            // Match reviews that either list this page OR have an empty pages array (show everywhere)
            query = { published: true, $or: [{ pages: page }, { pages: { $size: 0 } }] };
        }
        const reviews = await Review.find(query).sort({ order: 1, createdAt: -1 });
        res.json({ success: true, data: reviews });
    } catch (error) {
        console.error("Error fetching reviews:", error);
        res.status(500).json({ success: false, message: "Failed to fetch reviews" });
    }
});

// GET - Fetch ALL reviews including unpublished (admin only)
app.get("/api/reviews/admin/all", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        const reviews = await Review.find({}).sort({ order: 1, createdAt: -1 });
        res.json({ success: true, data: reviews });
    } catch (error) {
        console.error("Error fetching all reviews:", error);
        res.status(500).json({ success: false, message: "Failed to fetch reviews" });
    }
});

// POST - Bulk seed reviews (admin only) — idempotent, upserts by name
app.post("/api/reviews/seed", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        const reviews = req.body;
        if (!Array.isArray(reviews) || reviews.length === 0) {
            return res.status(400).json({ success: false, message: "Body must be a non-empty array" });
        }
        const results = [];
        for (const r of reviews) {
            if (!r.name || !r.quote) continue;
            const result = await Review.findOneAndUpdate(
                { name: r.name },
                { $set: r },
                { upsert: true, new: true, runValidators: true }
            );
            results.push(result.name);
        }
        res.json({ success: true, message: `${results.length} reviews seeded`, data: results });
    } catch (error) {
        console.error("Error seeding reviews:", error);
        res.status(500).json({ success: false, message: "Failed to seed reviews", error: error.message });
    }
});

// POST - Create new review (admin only)
app.post("/api/reviews", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        const { name, quote, rating, link, avatar, published, order, pages } = req.body;
        if (!name || !quote) {
            return res.status(400).json({ success: false, message: "name and quote are required" });
        }
        const review = new Review({ name, quote, rating, link, avatar, published, order, pages: pages || [] });
        await review.save();
        res.json({ success: true, message: "Review created!", data: review });
    } catch (error) {
        console.error("Error creating review:", error);
        res.status(500).json({ success: false, message: "Failed to create review", error: error.message });
    }
});

// PUT - Update a review by _id (admin only)
app.put("/api/reviews/:id", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        const updated = await Review.findByIdAndUpdate(
            req.params.id,
            { ...req.body },
            { new: true, runValidators: true }
        );
        if (!updated) {
            return res.status(404).json({ success: false, message: "Review not found" });
        }
        res.json({ success: true, message: "Review updated!", data: updated });
    } catch (error) {
        console.error("Error updating review:", error);
        res.status(500).json({ success: false, message: "Failed to update review", error: error.message });
    }
});

// DELETE - Delete a review by _id (admin only)
app.delete("/api/reviews/:id", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        const deleted = await Review.findByIdAndDelete(req.params.id);
        if (!deleted) {
            return res.status(404).json({ success: false, message: "Review not found" });
        }
        res.json({ success: true, message: "Review deleted!" });
    } catch (error) {
        console.error("Error deleting review:", error);
        res.status(500).json({ success: false, message: "Failed to delete review" });
    }
});

// GET - Legacy Google Places proxy (kept for backwards compat)
app.get("/api/reviews/google", async (req, res) => {
    try {
        await connectToDatabase();
        const dbReviews = await Review.find({ published: true }).sort({ order: 1, createdAt: -1 });
        if (dbReviews.length > 0) {
            return res.json({ success: true, source: "db", data: dbReviews });
        }
    } catch (err) {
        console.warn("DB unavailable for reviews, using static fallback");
    }
    res.json({ success: true, source: "fallback", data: fallbackReviews });
});

// ==========================================
// VIDEO TESTIMONIALS API
// ==========================================
// IMPORTANT: specific routes (/admin/all, /upload, /serve/:id) must come
// BEFORE the generic wildcard /:id routes.

// GET - All published videos, optional ?page= filter (public)
app.get("/api/videos", async (req, res) => {
    try {
        await connectToDatabase();
        const { page } = req.query;
        let query = { published: true };
        if (page) {
            query = { published: true, $or: [{ pages: page }, { pages: { $size: 0 } }] };
        }
        const videos = await VideoTestimonial.find(query).sort({ order: 1, createdAt: -1 });
        // Resolve videoFileId to a stream URL
        const data = videos.map(v => ({
            ...v.toObject(),
            resolvedUrl: v.videoFileId
                ? `/api/videos/serve/${v.videoFileId}`
                : v.videoUrl,
        }));
        res.json({ success: true, data });
    } catch (error) {
        console.error("Error fetching videos:", error);
        res.status(500).json({ success: false, message: "Failed to fetch videos" });
    }
});

// GET - All videos incl. unpublished (admin)
app.get("/api/videos/admin/all", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        const videos = await VideoTestimonial.find({}).sort({ order: 1, createdAt: -1 });
        const data = videos.map(v => ({
            ...v.toObject(),
            resolvedUrl: v.videoFileId ? `/api/videos/serve/${v.videoFileId}` : v.videoUrl,
        }));
        res.json({ success: true, data });
    } catch (error) {
        console.error("Error fetching all videos:", error);
        res.status(500).json({ success: false, message: "Failed to fetch videos" });
    }
});

// POST - Upload a video file to GridFS then create the VideoTestimonial document (admin)
app.post("/api/videos/upload", verifyToken, (req, res, next) => {
    videoUpload.single("video")(req, res, (err) => {
        if (err) return next(err);
        next();
    });
}, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: "Video file is required" });
        }
        const name = req.body.name || "Unnamed";
        const pages = req.body.pages ? JSON.parse(req.body.pages) : [];
        const order = req.body.order ? Number(req.body.order) : 0;

        const { gfsBucket } = await connectToDatabase();
        const fileName = `video_${Date.now()}_${req.file.originalname}`;
        const uploadStream = gfsBucket.openUploadStream(fileName, {
            contentType: req.file.mimetype,
        });
        const fileId = uploadStream.id;

        await new Promise((resolve, reject) => {
            const { PassThrough } = require("stream");
            const buf = new PassThrough();
            buf.end(req.file.buffer);
            buf.pipe(uploadStream).on("error", reject).on("finish", resolve);
        });

        const doc = new VideoTestimonial({ name, videoFileId: fileId, pages, order });
        await doc.save();

        res.json({
            success: true,
            message: "Video uploaded!",
            data: { ...doc.toObject(), resolvedUrl: `/api/videos/serve/${fileId}` },
        });
    } catch (error) {
        console.error("Error uploading video:", error);
        res.status(500).json({ success: false, message: "Failed to upload video", error: error.message });
    }
});

// GET - Stream a video from GridFS (public)
app.get("/api/videos/serve/:id", async (req, res) => {
    try {
        const { gfsBucket } = await connectToDatabase();
        const fileId = new mongoose.Types.ObjectId(req.params.id);
        const files = await gfsBucket.find({ _id: fileId }).toArray();
        if (!files || files.length === 0) {
            return res.status(404).json({ success: false, message: "Video not found" });
        }
        const file = files[0];

        // Support range requests for native video seeking in browser
        const range = req.headers.range;
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : file.length - 1;
            const chunkSize = end - start + 1;
            res.writeHead(206, {
                "Content-Range": `bytes ${start}-${end}/${file.length}`,
                "Accept-Ranges": "bytes",
                "Content-Length": chunkSize,
                "Content-Type": file.contentType || "video/mp4",
            });
            gfsBucket.openDownloadStream(fileId, { start, end: end + 1 }).pipe(res);
        } else {
            res.set({
                "Content-Type": file.contentType || "video/mp4",
                "Content-Length": file.length,
                "Accept-Ranges": "bytes",
            });
            gfsBucket.openDownloadStream(fileId).pipe(res);
        }
    } catch (err) {
        console.error("Error serving video:", err);
        res.status(400).json({ success: false, message: "Invalid video ID" });
    }
});

// POST - Create video entry with external URL (no file upload) (admin)
app.post("/api/videos", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        const { name, videoUrl, pages, order, published } = req.body;
        if (!name) return res.status(400).json({ success: false, message: "name is required" });
        if (!videoUrl) return res.status(400).json({ success: false, message: "videoUrl is required for URL-only entries" });
        const doc = new VideoTestimonial({ name, videoUrl, pages: pages || [], order: order || 0, published: published ?? true });
        await doc.save();
        res.json({ success: true, message: "Video entry created!", data: { ...doc.toObject(), resolvedUrl: videoUrl } });
    } catch (error) {
        console.error("Error creating video:", error);
        res.status(500).json({ success: false, message: "Failed to create video entry", error: error.message });
    }
});

// PUT - Update video entry by _id (admin)
app.put("/api/videos/:id", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        const updated = await VideoTestimonial.findByIdAndUpdate(
            req.params.id, { ...req.body }, { new: true, runValidators: true }
        );
        if (!updated) return res.status(404).json({ success: false, message: "Video not found" });
        res.json({ success: true, message: "Video updated!", data: {
            ...updated.toObject(),
            resolvedUrl: updated.videoFileId ? `/api/videos/serve/${updated.videoFileId}` : updated.videoUrl,
        }});
    } catch (error) {
        console.error("Error updating video:", error);
        res.status(500).json({ success: false, message: "Failed to update video", error: error.message });
    }
});

// DELETE - Delete video entry + GridFS file if applicable (admin)
app.delete("/api/videos/:id", verifyToken, async (req, res) => {
    try {
        await connectToDatabase();
        const doc = await VideoTestimonial.findByIdAndDelete(req.params.id);
        if (!doc) return res.status(404).json({ success: false, message: "Video not found" });
        // Clean up GridFS file if it was an upload
        if (doc.videoFileId) {
            try {
                const { gfsBucket } = await connectToDatabase();
                await gfsBucket.delete(new mongoose.Types.ObjectId(doc.videoFileId));
            } catch (e) {
                console.warn("Could not delete GridFS video file:", e.message);
            }
        }
        res.json({ success: true, message: "Video deleted!" });
    } catch (error) {
        console.error("Error deleting video:", error);
        res.status(500).json({ success: false, message: "Failed to delete video" });
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
    if (err.message === "Only PDF files are allowed!" || err.message.startsWith("Only image files are allowed")) {
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
