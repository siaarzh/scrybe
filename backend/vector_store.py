from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    MatchValue,
    PointStruct,
    VectorParams,
)

from .config import DATA_DIR, settings
from .models import CodeChunk, SearchResult

_client: QdrantClient | None = None


def _get_client() -> QdrantClient:
    global _client
    if _client is None:
        _client = QdrantClient(path=str(DATA_DIR / "qdrant_data"))
    return _client


def ensure_collection() -> None:
    client = _get_client()
    existing = {c.name for c in client.get_collections().collections}
    if settings.collection_name not in existing:
        client.create_collection(
            collection_name=settings.collection_name,
            vectors_config=VectorParams(
                size=settings.embedding_dimensions,
                distance=Distance.COSINE,
            ),
        )


def upsert(chunks: list[CodeChunk], vectors: list[list[float]]) -> None:
    client = _get_client()
    points = [
        PointStruct(
            id=int(chunk.id[:16], 16) % (2**63),  # Qdrant needs int or UUID
            vector=vector,
            payload={
                "chunk_id": chunk.id,
                "project_id": chunk.project_id,
                "file_path": chunk.file_path,
                "content": chunk.content,
                "start_line": chunk.start_line,
                "end_line": chunk.end_line,
                "language": chunk.language,
                "symbol_name": chunk.symbol_name,
            },
        )
        for chunk, vector in zip(chunks, vectors)
    ]
    client.upsert(collection_name=settings.collection_name, points=points)


def search(
    query_vector: list[float], project_id: str, top_k: int = 10
) -> list[SearchResult]:
    client = _get_client()
    response = client.query_points(
        collection_name=settings.collection_name,
        query=query_vector,
        query_filter=Filter(
            must=[FieldCondition(key="project_id", match=MatchValue(value=project_id))]
        ),
        limit=top_k,
        with_payload=True,
    )
    return [
        SearchResult(
            score=hit.score,
            file_path=hit.payload["file_path"],
            start_line=hit.payload["start_line"],
            end_line=hit.payload["end_line"],
            language=hit.payload["language"],
            symbol_name=hit.payload.get("symbol_name", ""),
            content=hit.payload["content"],
            project_id=hit.payload["project_id"],
        )
        for hit in response.points
    ]


def delete_project(project_id: str) -> None:
    client = _get_client()
    client.delete(
        collection_name=settings.collection_name,
        points_selector=Filter(
            must=[FieldCondition(key="project_id", match=MatchValue(value=project_id))]
        ),
    )


def delete_file_chunks(project_id: str, file_path: str) -> None:
    client = _get_client()
    client.delete(
        collection_name=settings.collection_name,
        points_selector=Filter(
            must=[
                FieldCondition(key="project_id", match=MatchValue(value=project_id)),
                FieldCondition(key="file_path", match=MatchValue(value=file_path)),
            ]
        ),
    )
