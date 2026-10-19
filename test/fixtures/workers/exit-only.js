// Test fixture: a worker that exits cleanly without ever replying. The parent
// must treat the missing result as a failure.
process.exit(0);
