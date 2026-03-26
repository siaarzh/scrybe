import tiktoken
from openai import OpenAI
from .config import settings

_client: OpenAI | None = None
_tokenizer: tiktoken.Encoding | None = None

_MAX_TOKENS = 8000  # stay under the 8192 limit


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(api_key=settings.openai_api_key)
    return _client


def _get_tokenizer() -> tiktoken.Encoding:
    global _tokenizer
    if _tokenizer is None:
        _tokenizer = tiktoken.get_encoding("cl100k_base")
    return _tokenizer


def _truncate_to_token_limit(text: str) -> str:
    enc = _get_tokenizer()
    tokens = enc.encode(text)
    if len(tokens) <= _MAX_TOKENS:
        return text
    return enc.decode(tokens[:_MAX_TOKENS])


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a list of texts in one API call. Returns a list of float vectors."""
    if not texts:
        return []
    truncated = [_truncate_to_token_limit(t) for t in texts]
    response = _get_client().embeddings.create(
        model=settings.embedding_model,
        input=truncated,
    )
    return [item.embedding for item in sorted(response.data, key=lambda x: x.index)]


def embed_batched(texts: list[str], batch_size: int | None = None) -> list[list[float]]:
    """Embed texts in batches to avoid hitting API limits."""
    size = batch_size or settings.embed_batch_size
    vectors: list[list[float]] = []
    for i in range(0, len(texts), size):
        batch = texts[i : i + size]
        vectors.extend(embed_texts(batch))
    return vectors
