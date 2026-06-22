const mongoose = require("mongoose");

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

// Schema for Blogs
const blogSchema = new mongoose.Schema({
    title: { type: String, required: true },
    subtitle: { type: String },
    content: { type: String, required: true },
    category: { type: String, required: true },
    tags: [{ type: String }],
    imageUrl: { type: String },
    readTime: { type: String },
    authorName: { type: String, default: "SkillBridge Team" },
    published: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
});

// Avoid recompiling models on multiple imports, critical for serverless functions
const InternshipContact = mongoose.models.InternshipContact || mongoose.model("InternshipContact", internshipContactSchema);
const GeneralContact = mongoose.models.GeneralContact || mongoose.model("GeneralContact", generalContactSchema);
const Blog = mongoose.models.Blog || mongoose.model("Blog", blogSchema);

module.exports = {
    InternshipContact,
    GeneralContact,
    Blog
};
