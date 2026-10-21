// Test fixture: a worker that throws before it can reply (simulates a crashing
// parser or a startup error inside the worker).
throw new Error("worker blew up at startup");
