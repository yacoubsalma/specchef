"""
─── Tokenizer Server ────────────────────────────────────────────────────────────
Microservice HTTP local — compte les tokens exacts pour Qwen2.5-Coder-7B.
Tourne sur http://localhost:5001

Installation :
  pip install transformers torch langfuse python-dotenv

Lancement :
  python tokenizer-server.py

Endpoints :
  POST /tokenize   { "text": "..." }  →  { "count": 42 }
  GET  /health                        →  { "status": "ok", "model": "..." }

Tracing Langfuse :
  Réutilise les mêmes variables d'environnement que le backend Node
  (LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL), lues
  depuis backend/.env si python-dotenv est installé. Si les clés sont
  absentes ou si le package langfuse n'est pas installé, le tracing est
  silencieusement désactivé — le service de tokenisation continue de
  fonctionner normalement (best-effort, jamais bloquant).
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
from transformers import AutoTokenizer
import json
import os
import sys
import time

MODEL_ID = "Qwen/Qwen2.5-Coder-7B-Instruct"
PORT     = 5001

# ── Chargement des variables d'environnement (.env du backend Node) ──────────
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
except ImportError:
    pass  # python-dotenv absent — on retombe sur les vraies variables d'env du shell

# ── Client Langfuse (optionnel) ───────────────────────────────────────────────
langfuse_client = None
try:
    from langfuse import Langfuse
    _public_key = os.environ.get("LANGFUSE_PUBLIC_KEY")
    _secret_key = os.environ.get("LANGFUSE_SECRET_KEY")
    _base_url   = os.environ.get("LANGFUSE_BASE_URL", "https://cloud.langfuse.com")
    if _public_key and _secret_key:
        langfuse_client = Langfuse(public_key=_public_key, secret_key=_secret_key, host=_base_url)
        print(f"[tokenizer-server] ✓ Langfuse tracing activé → {_base_url}")
    else:
        print("[tokenizer-server] ⚠️  Clés Langfuse absentes — tracing désactivé")
except ImportError:
    print("[tokenizer-server] ⚠️  Package 'langfuse' non installé — tracing désactivé")


def _trace_tokenize(text: str, count: int, duration_ms: float, error: str = None):
    """Envoie une trace 'tokenize' à Langfuse. Best-effort, ne doit jamais lever."""
    if langfuse_client is None:
        return
    try:
        trace = langfuse_client.trace(
            name="tokenize",
            metadata={"model": MODEL_ID, "textLength": len(text)},
        )
        span = trace.span(
            name="qwen2.5-coder-tokenizer",
            input=text[:500],
            metadata={"model": MODEL_ID},
        )
        if error:
            span.end(output=None, level="ERROR", status_message=f"✗ {error}")
        else:
            span.end(
                output={"count": count},
                level="DEFAULT",
                status_message=f"✓ {count} tokens en {duration_ms:.0f}ms",
            )
    except Exception:
        pass  # Ne jamais casser la réponse HTTP pour un souci de tracing


# ── Chargement du tokenizer (une seule fois au démarrage) ────────────────────
print(f"[tokenizer-server] Chargement du tokenizer {MODEL_ID}...")
try:
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
    print(f"[tokenizer-server] ✓ Tokenizer prêt — écoute sur http://localhost:{PORT}")
except Exception as e:
    print(f"[tokenizer-server] ✗ Erreur chargement tokenizer: {e}")
    sys.exit(1)


class TokenizerHandler(BaseHTTPRequestHandler):

    def _send_json(self, code: int, data: dict):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, { "status": "ok", "model": MODEL_ID, "port": PORT })
        else:
            self._send_json(404, { "error": "Not found" })

    def do_POST(self):
        if self.path != "/tokenize":
            self._send_json(404, { "error": "Not found" })
            return

        text = ""
        start = time.monotonic()
        try:
            length = int(self.headers.get("Content-Length", 0))
            body   = json.loads(self.rfile.read(length))
            text   = body.get("text", "")

            if not text:
                self._send_json(400, { "error": "Champ 'text' requis" })
                return

            tokens = tokenizer.encode(text, add_special_tokens=False)
            count  = len(tokens)
            _trace_tokenize(text, count, (time.monotonic() - start) * 1000)
            self._send_json(200, { "count": count })

        except Exception as e:
            _trace_tokenize(text, 0, (time.monotonic() - start) * 1000, error=str(e))
            self._send_json(500, { "error": str(e) })

    # Silence les logs de requêtes
    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    server = HTTPServer(("localhost", PORT), TokenizerHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[tokenizer-server] Arrêt.")
        if langfuse_client is not None:
            langfuse_client.flush()
        server.shutdown()