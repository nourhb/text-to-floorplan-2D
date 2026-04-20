## text-to-floor-plan-ai

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

