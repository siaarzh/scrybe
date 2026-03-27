from pathlib import Path

from platformdirs import user_data_dir
from pydantic_settings import BaseSettings, SettingsConfigDict

DATA_DIR = Path(user_data_dir("scrybe"))


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=Path(__file__).parent.parent / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    openai_api_key: str = ""
    collection_name: str = "scrybe_code"
    embedding_model: str = "text-embedding-3-small"
    embedding_dimensions: int = 1536
    chunk_size: int = 60  # lines per chunk
    chunk_overlap: int = 10  # overlapping lines between chunks
    embed_batch_size: int = 100


settings = Settings()
