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

// ============================================================
// Schema for Courses (drives InternshipDetailPage.jsx)
//
// Icons in programHighlights.features and whoShouldApply are stored
// as string keys (e.g. "FaLaptopCode") and resolved to React components
// by src/sections/internship/utils/iconMap.js on the frontend.
//
// Tool images (toolsCovered[].imageUrl) are stored as public URLs.
// If empty, InternshipDetailPage shows a letter-initial fallback.
// ============================================================
const courseSchema = new mongoose.Schema({
    // URL slug — matches the :courseType param in /virtual-internship/:courseType
    slug: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    shortTitle: { type: String },

    // Hero section
    hero: {
        headline: String,
        subheadline: String,
        description: String,
        statistics: [{ value: String, label: String, ref: String }],
    },

    // Important notice box shown near top of page
    importantNotice: {
        title: String,
        requirements: [String],
        reason: String,
    },

    // Program highlights (duration + feature cards)
    programHighlights: {
        duration: String,
        features: [{
            iconKey: String,    // Icon identifier, e.g. "FaLaptopCode" — resolved by iconMap.js
            title: String,
            description: String,
        }],
    },

    // Tools & technologies grid
    toolsCovered: [{
        name: String,
        description: String,
        imageUrl: String,       // Public URL; empty string shows letter-initial fallback
    }],

    // "Why choose us?" reason cards
    whyThisProgram: [{ title: String, description: String }],

    // Full program detail cards
    programDetails: {
        overview: {
            title: String,
            description: String,
            phases: [{ title: String, description: String }],
        },
        modeOfDelivery: { title: String, description: String },
        commitment: { title: String, description: String },
        curriculum: {
            title: String,
            description: String,
            points: [String],
        },
        mentorship: { title: String, description: String },
        certification: { title: String, description: String },
        careerAdvancement: {
            title: String,
            description: String,
            additionalInfo: String,
            careerPaths: String,
        },
    },

    // Who should apply cards
    whoShouldApply: [{
        iconKey: String,        // Icon identifier (emoji or react-icons key)
        title: String,
        description: String,
    }],

    // Alumni video carousel
    aluminiVideos: [{
        id: Number,
        name: String,
        videoUrl: String,
    }],

    // "Why alumni get hired" cards (icon is typically an emoji string)
    whyAlumniGetHired: [{
        icon: String,
        title: String,
        description: String,
    }],

    // Miscellaneous
    testimonialLink: String,
    contactEmail: String,
    footerNote: String,

    // Admin controls
    published: { type: Boolean, default: true },
    order: { type: Number, default: 0 },    // Controls display order on course listings
    createdAt: { type: Date, default: Date.now },
});

// ============================================================
// Schema for Admin-Managed Reviews
// These are shown in the Testimonials section on the internship/home pages.
// Stored in MongoDB so they can be managed from the admin dashboard
// without a code deploy.
// ============================================================
const reviewSchema = new mongoose.Schema({
    name: { type: String, required: true },          // Reviewer full name
    quote: { type: String, required: true },          // Review text
    rating: { type: Number, default: 5, min: 1, max: 5 }, // Star rating (1-5)
    link: { type: String, default: '' },              // URL to the Google review (optional)
    avatar: { type: String, default: '' },            // Avatar image URL (optional; falls back to coloured initial)
    published: { type: Boolean, default: true },      // Controls visibility on public pages
    order: { type: Number, default: 0 },              // Lower number = shown first
    createdAt: { type: Date, default: Date.now },
});

// Avoid recompiling models on multiple imports — critical for Vercel serverless functions
const InternshipContact = mongoose.models.InternshipContact || mongoose.model("InternshipContact", internshipContactSchema);
const GeneralContact = mongoose.models.GeneralContact || mongoose.model("GeneralContact", generalContactSchema);
const Blog = mongoose.models.Blog || mongoose.model("Blog", blogSchema);
const Course = mongoose.models.Course || mongoose.model("Course", courseSchema);
const Review = mongoose.models.Review || mongoose.model("Review", reviewSchema);

module.exports = {
    InternshipContact,
    GeneralContact,
    Blog,
    Course,
    Review,
};
