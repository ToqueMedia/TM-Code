import express from "express";

const app = express();
const PORT = Number(process.env.PORT) || 7777;

app.get("/", (_req, res) => {
  res.json({ message: "Hello World" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
