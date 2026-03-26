from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=Path(__file__).parent.parent / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    openai_api_key: str = ""
    qdrant_url: str = "http://localhost:6333"
    collection_name: str = "scrybe_code"
    embedding_model: str = "text-embedding-3-small"
    embedding_dimensions: int = 1536
    chunk_size: int = 60       # lines per chunk
    chunk_overlap: int = 10    # overlapping lines between chunks
    embed_batch_size: int = 100


settings = Settings()
