<img width="1920" height="1717" alt="image" src="https://github.com/user-attachments/assets/4b4f1291-dc87-4304-a180-6c32c2d47fb8" />## text-to-floor-plan-ai

Standalone **Text → 2D floor plan (SVG)** generator extracted from your AI2D feature.

### Run

```bash
cd server
npm install
npm run dev
```

Then open `http://localhost:5009` in your browser.

### API

- `POST /ai/plan-2d`
  - body: `{ "input": "…", "norms": "fr" | "int" }`
  - returns: `{ success, data: { svg, plan }, meta }`

### Environment

Copy `server/.env.example` to `server/.env` and set keys if you want LLM mode (Groq/OpenAI).  
If no API keys are set, it still works in deterministic mode.
<img width="1920" height="1717" alt="screencapture-localhost-5009-2026-04-20-10_17_46" src="https://github.com/user-attachments/assets/40ce8180-6bad-42b5-beda-989b1f004c7f" />

