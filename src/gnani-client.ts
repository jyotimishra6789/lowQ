import { randomUUID } from 'node:crypto';

const STT_URL = 'https://api.vachana.ai/stt/v3';
const TTS_URL = 'https://api.vachana.ai/api/v1/tts/inference';

export interface TtsRequest {
  text: string;
  voice: string;
  model?: 'timbre-v2.5' | 'timbre-v3.0';
  language?: string;
  speed?: number;
  audio_config?: Record<string, unknown>;
}

export class GnaniClient {
  constructor(
    private readonly apiKey = process.env.GNANI_API_KEY,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async transcribe(audio: Buffer, filename: string, contentType: string, languageCode: string): Promise<unknown> {
    const body = new FormData();
    const audioBuffer = new ArrayBuffer(audio.byteLength);
    new Uint8Array(audioBuffer).set(audio);
    body.append('audio_file', new Blob([audioBuffer], { type: contentType }), filename);
    body.append('language_code', languageCode);
    const response = await this.fetcher(STT_URL, {
      method: 'POST',
      headers: this.headers(),
      body
    });
    return this.readResponse(response);
  }

  async synthesize(request: TtsRequest): Promise<Response> {
    return this.fetcher(TTS_URL, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model ?? 'timbre-v3.0',
        language: request.language ?? 'en-IN',
        speed: request.speed ?? 1,
        audio_config: request.audio_config ?? { container: 'wav' },
        ...request
      })
    });
  }

  private headers(): Record<string, string> {
    if (!this.apiKey) throw new Error('GNANI_API_KEY is not configured');
    return { 'X-API-Key-ID': this.apiKey, 'X-API-Request-ID': randomUUID() };
  }

  private async readResponse(response: Response): Promise<unknown> {
    if (response.ok) return response.json();
    const detail = await response.text();
    throw new Error(`Gnani request failed (${response.status}): ${detail}`);
  }
}
