const express = require("express");

const app = express();
const port = Number(process.env.PORT) || 3000;

app.get("/", (_req, res) => {
  res.status(200).send("Gruble API kjører");
});

app.get("/api/quiz/today", (_req, res) => {
  res.status(200).json({
    theme: "Test",
    questions: [
      {
        id: 1,
        question: "Hva heter hovedstaden i Norge?",
        options: ["Oslo", "Bergen", "Trondheim", "Stavanger"],
      },
    ],
  });
});

app.listen(port, () => {
  console.log(`Gruble API listening on port ${port}`);
});
