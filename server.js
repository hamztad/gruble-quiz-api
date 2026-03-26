Oppdater server.js slik at vi får et nytt endpoint:

GET /api/quiz/today

Dette endpointet skal returnere hardkodet testdata (ikke database ennå).

Eksempel på respons:

{
  "theme": "Test",
  "questions": [
    {
      "id": 1,
      "question": "Hva heter hovedstaden i Norge?",
      "options": ["Oslo", "Bergen", "Trondheim", "Stavanger"]
    }
  ]
}

Krav:
- bruk Express
- behold eksisterende server
- legg kun til dette ene endpointet
- ingen database ennå
