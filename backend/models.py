from pydantic import BaseModel


class Project(BaseModel):
    id: str
    root_path: str
    languages: list[str] = []
    description: str = ""


class CodeChunk(BaseModel):
    id: str
    project_id: str
    file_path: str
    content: str
    start_line: int
    end_line: int
    language: str
    symbol_name: str = ""


class SearchResult(BaseModel):
    score: float
    file_path: str
    start_line: int
    end_line: int
    language: str
    symbol_name: str
    content: str
    project_id: str


class SearchRequest(BaseModel):
    project_id: str
    query: str
    top_k: int = 10


class IndexRequest(BaseModel):
    project_id: str
    mode: str = "full"
