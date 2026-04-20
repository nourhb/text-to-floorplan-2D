// IMPORTANT:
// maria26/Floor_Plan_LoRA is a LoRA adapter (not a standalone hosted inference model).
// HuggingFace Inference API cannot run it directly unless you deploy a custom endpoint/Space
// that loads SD1.5 + the LoRA weights.
//
// Therefore this service expects an endpoint URL that *already runs* text-to-image inference.
// Example (you create): a HuggingFace Space or Inference Endpoint you control.
const DEFAULT_HF_ENDPOINT_URL = '';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cleanup: () => clearTimeout(t) };
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Call HuggingFace Inference API for maria26/Floor_Plan_LoRA.
 * Handles cold-start 503 with retries and surfaces JSON errors.
 *
 * @param {{ token: string, prompt: string, steps?: number, guidance?: number, width?: number, height?: number, timeoutMs?: number }} args
 */
export async function callHuggingFaceFloorplanLora({
  token,
  prompt,
  steps = 30,
  guidance = 7.5,
  width = 512,
  height = 512,
  timeoutMs = 90_000,
}) {
  const tok = String(token || '').trim();
  if (!tok) throw new Error('hf_token_missing');
  const inputs = String(prompt || '').trim();
  if (!inputs) throw new Error('hf_prompt_missing');

  const endpointUrl = String(process.env.HF_FLOORPLAN_ENDPOINT_URL || DEFAULT_HF_ENDPOINT_URL).trim();
  if (!endpointUrl) {
    throw new Error('hf_endpoint_missing: set HF_FLOORPLAN_ENDPOINT_URL (Space/Endpoint running SD1.5+LoRA)');
  }

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { signal, cleanup } = withTimeout(timeoutMs);
    try {
      const res = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tok}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs,
          parameters: {
            num_inference_steps: steps,
            guidance_scale: guidance,
            width,
            height,
          },
        }),
        signal,
      });

      // Cold start: 503 + loading message
      if (res.status === 503) {
        const txt = await safeReadText(res);
        if (attempt < maxRetries - 1) {
          // HF often returns JSON: {"error":"Model ... is currently loading","estimated_time":...}
          await sleep(20_000);
          continue;
        }
        throw new Error(`hf_model_loading_503:${txt.slice(0, 200)}`);
      }

      if (res.status === 429) {
        const txt = await safeReadText(res);
        throw new Error(`hf_rate_limited_429:${txt.slice(0, 200)}`);
      }

      if (!res.ok) {
        const txt = await safeReadText(res);
        throw new Error(`hf_http_${res.status}:${txt.slice(0, 240)}`);
      }

      const ct = String(res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('application/json')) {
        const txt = await safeReadText(res);
        throw new Error(`hf_json_error_200:${txt.slice(0, 240)}`);
      }

      const buf = Buffer.from(await res.arrayBuffer());
      const b64 = buf.toString('base64');
      return { image: `data:image/png;base64,${b64}` };
    } finally {
      cleanup();
    }
  }

  throw new Error('hf_unknown_failure');
}

