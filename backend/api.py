from fastapi import FastAPI, HTTPException

from . import embedder, indexer, registry, vector_store
from .models import IndexRequest, Project, SearchRequest, SearchResult

app = FastAPI(title="scrybe", description="Self-hosted code memory API")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/projects", response_model=list[Project])
def get_projects():
    return registry.list_projects()


@app.post("/search", response_model=list[SearchResult])
def search(req: SearchRequest):
    project = registry.get_project(req.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project '{req.project_id}' not found.")
    vector_store.ensure_collection()
    query_vector = embedder.embed_texts([req.query])[0]
    return vector_store.search(query_vector, req.project_id, req.top_k)


@app.post("/index")
def index(req: IndexRequest):
    project = registry.get_project(req.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project '{req.project_id}' not found.")
    try:
        result = indexer.index_project(req.project_id, req.mode)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return result
