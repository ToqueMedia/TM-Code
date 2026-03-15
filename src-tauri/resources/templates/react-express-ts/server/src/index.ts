import express from "express";

const app = express();
const PORT = 3001;

app.get("/api", (_req, res) => {
  res.json({ message: "Hello World" });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
