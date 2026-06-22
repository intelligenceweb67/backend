const mongoose = require("mongoose");
const { GridFSBucket } = require("mongodb");

let cachedDb = null;
let gfsBucket = null;

/**
 * Connects to MongoDB, caching the connection for serverless performance
 * and initializing the GridFS resume bucket.
 */
async function connectToDatabase() {
    if (cachedDb && gfsBucket) {
        console.log("Using cached database connection");
        return { db: cachedDb, gfsBucket };
    }

    try {
        console.log("Connecting to MongoDB...");
        const conn = await mongoose.connect(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: 5000,
        });

        cachedDb = conn.connection.db;
        gfsBucket = new GridFSBucket(cachedDb, {
            bucketName: "resumes",
        });

        console.log("MongoDB Connected Successfully!");
        console.log("GridFS Bucket Ready!");

        return { db: cachedDb, gfsBucket };
    } catch (err) {
        console.error("MongoDB Connection Error:", err);
        throw err;
    }
}

/**
 * Returns the currently active GridFSBucket instance.
 * Returns null if database is not connected.
 */
function getGfsBucket() {
    return gfsBucket;
}

module.exports = {
    connectToDatabase,
    getGfsBucket
};
