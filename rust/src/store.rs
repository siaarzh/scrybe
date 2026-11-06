//! Read-only LanceDB access. Mirrors the search paths of `src/vector-store.ts`.
use crate::config::{data_dir, Settings};
use anyhow::Result;
use crate::chunk::Chunk;
use arrow_array::{Array, ArrayRef, FixedSizeListArray, Float32Array, Float64Array, Int32Array, Int64Array, LargeStringArray, RecordBatch, RecordBatchIterator, StringArray, StringViewArray, UInt32Array, UInt64Array};
use arrow_schema::{DataType, Field, Schema};
use futures::TryStreamExt;
use lancedb::index::scalar::{FtsIndexBuilder, FtsQuery, FullTextSearchQuery, MatchQuery, PhraseQuery};
use lancedb::index::Index;
use lancedb::table::OptimizeAction;
use lancedb::query::{ExecutableQuery, QueryBase};
use lancedb::{connect, Connection, DistanceType, Table};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::OnceCell;

pub const CURRENT_CHUNK_ID_SCHEME: i64 = 2;

pub fn db_path() -> PathBuf {
    data_dir().join("lancedb")
}

/// Mirrors `needsMigration`: no sidecar, a string marker, or an older scheme all count.
pub fn needs_migration(table: &str) -> bool {
    let path = db_path().join(format!("{table}-meta.json"));
    let Ok(text) = std::fs::read_to_string(path) else { return true };
    let Ok(meta) = serde_json::from_str::<serde_json::Value>(&text) else { return true };
    match meta.get("chunk_id_scheme") {
        Some(v) if v.is_string() => true,
        Some(v) => v.as_i64().unwrap_or(0) < CURRENT_CHUNK_ID_SCHEME,
        None => true,
    }
}

pub fn escape_sql(v: &str) -> String {
    v.replace('\'', "''")
}

pub struct Store {
    db: OnceCell<Connection>,
    tables: Mutex<HashMap<String, Table>>,
    has_vector_index: Mutex<HashMap<String, bool>>,
    pub settings: Settings,
}

/// A row as JS sees it: strings via `String(x)`, numbers via `Number(x)`.
pub struct Rows {
    batches: Vec<RecordBatch>,
}

impl Rows {
    pub fn iter(&self) -> impl Iterator<Item = Row<'_>> {
        self.batches.iter().flat_map(|b| (0..b.num_rows()).map(move |i| Row { batch: b, i }))
    }
}

pub struct Row<'a> {
    batch: &'a RecordBatch,
    i: usize,
}

impl Row<'_> {
    fn col(&self, name: &str) -> Option<&ArrayRef> {
        self.batch.column_by_name(name)
    }
    /// `String(row[name])`: a null becomes the text "null", as it does in the TypeScript.
    pub fn string(&self, name: &str) -> String {
        self.opt_string(name).unwrap_or_else(|| "null".to_string())
    }
    /// `String(row[name] ?? "")`.
    pub fn string_or_empty(&self, name: &str) -> String {
        self.opt_string(name).unwrap_or_default()
    }
    fn opt_string(&self, name: &str) -> Option<String> {
        let col = self.col(name)?;
        if col.is_null(self.i) {
            return None;
        }
        if let Some(a) = col.as_any().downcast_ref::<StringArray>() {
            return Some(a.value(self.i).to_string());
        }
        if let Some(a) = col.as_any().downcast_ref::<LargeStringArray>() {
            return Some(a.value(self.i).to_string());
        }
        if let Some(a) = col.as_any().downcast_ref::<StringViewArray>() {
            return Some(a.value(self.i).to_string());
        }
        None
    }
    pub fn number(&self, name: &str) -> f64 {
        let Some(col) = self.col(name) else { return 0.0 };
        if col.is_null(self.i) {
            return 0.0;
        }
        let any = col.as_any();
        if let Some(a) = any.downcast_ref::<Float32Array>() {
            return a.value(self.i) as f64;
        }
        if let Some(a) = any.downcast_ref::<Float64Array>() {
            return a.value(self.i);
        }
        if let Some(a) = any.downcast_ref::<Int32Array>() {
            return a.value(self.i) as f64;
        }
        if let Some(a) = any.downcast_ref::<Int64Array>() {
            return a.value(self.i) as f64;
        }
        if let Some(a) = any.downcast_ref::<UInt32Array>() {
            return a.value(self.i) as f64;
        }
        if let Some(a) = any.downcast_ref::<UInt64Array>() {
            return a.value(self.i) as f64;
        }
        0.0
    }
}

fn code_schema(dimensions: i32) -> Arc<Schema> {
    let text = |n: &str| Field::new(n, DataType::Utf8, false);
    Arc::new(Schema::new(vec![
        text("chunk_id"),
        text("project_id"),
        text("item_path"),
        text("content"),
        Field::new("start_line", DataType::Int32, false),
        Field::new("end_line", DataType::Int32, false),
        text("language"),
        text("symbol_name"),
        Field::new("vector", DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, false)), dimensions), false),
    ]))
}

impl Store {
    pub fn new(settings: Settings) -> Self {
        Store { db: OnceCell::new(), tables: Mutex::default(), has_vector_index: Mutex::default(), settings }
    }

    async fn conn(&self) -> Result<&Connection> {
        Ok(self
            .db
            .get_or_try_init(|| async {
                let mut builder = connect(&db_path().to_string_lossy());
                let mb = |name: &str| std::env::var(name).ok().and_then(|v| v.parse::<usize>().ok());
                // Experiment: LanceDB defaults to a 6 GiB index cache and 1 GiB metadata cache.
                if let (Some(index), Some(meta)) = (mb("SCRYBE_LANCE_INDEX_CACHE_MB"), mb("SCRYBE_LANCE_META_CACHE_MB")) {
                    builder = builder.session(Arc::new(lancedb::Session::new(index << 20, meta << 20, Arc::new(lancedb::ObjectStoreRegistry::default()))));
                }
                builder.execute().await
            })
            .await?)
    }

    pub async fn open(&self, name: &str) -> Result<Option<Table>> {
        if let Some(t) = self.tables.lock().unwrap().get(name) {
            return Ok(Some(t.clone()));
        }
        match self.conn().await?.open_table(name).execute().await {
            Ok(t) => {
                self.tables.lock().unwrap().insert(name.to_string(), t.clone());
                Ok(Some(t))
            }
            Err(lancedb::Error::TableNotFound { .. }) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Mirrors `vectorIndexPresent`, including the on-disk check: a manifest entry can outlive its dir.
    async fn vector_index_present(&self, name: &str, table: &Table) -> Result<bool> {
        if let Some(v) = self.has_vector_index.lock().unwrap().get(name) {
            return Ok(*v);
        }
        let in_manifest = table
            .list_indices()
            .await?
            .iter()
            .any(|i| i.index_type.to_string().to_uppercase().contains("HNSW") && i.columns.iter().any(|c| c == "vector"));
        let exists = in_manifest
            && std::fs::read_dir(db_path().join(format!("{name}.lance")).join("_indices"))
                .map(|d| d.flatten().any(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false)))
                .unwrap_or(false);
        self.has_vector_index.lock().unwrap().insert(name.to_string(), exists);
        Ok(exists)
    }

    pub async fn vector_search(&self, name: &str, vec: &[f32], where_: &str, top_k: usize) -> Result<Rows> {
        let Some(table) = self.open(name).await? else { return Ok(Rows { batches: vec![] }) };
        let mut query = table.query().nearest_to(vec)?.distance_type(DistanceType::Cosine).only_if(where_).limit(top_k);
        if self.settings.vector_index_enabled && self.vector_index_present(name, &table).await? {
            let refine = self.settings.vector_refine_factor;
            let ef = self.settings.vector_ef.max(top_k * refine as usize);
            query = query.refine_factor(refine).ef(ef);
        } else {
            query = query.bypass_vector_index();
        }
        Ok(Rows { batches: query.execute().await?.try_collect().await? })
    }

    /// Same query the Node binding builds for `table.search(text, "fts", "content")`.
    pub async fn fts_search(&self, name: &str, text: &str, where_: &str, top_k: usize) -> Result<Rows> {
        let Some(table) = self.open(name).await? else { return Ok(Rows { batches: vec![] }) };
        let is_phrase = text.len() >= 2 && text.starts_with('"') && text.ends_with('"');
        let fts: FtsQuery = if is_phrase {
            PhraseQuery::new(text[1..text.len() - 1].to_string()).into()
        } else {
            MatchQuery::new(text.to_string()).into()
        };
        let q = FullTextSearchQuery::new_query(fts).with_columns(&["content".to_string()])?;
        let stream = table.query().full_text_search(q).only_if(where_).limit(top_k).execute().await?;
        Ok(Rows { batches: stream.try_collect().await? })
    }

    /// `getProjectTable` for a write: creates the table and its sidecar on first use.
    async fn open_or_create_code(&self, name: &str, dimensions: i32) -> Result<Table> {
        if let Some(t) = self.open(name).await? {
            return Ok(t);
        }
        std::fs::create_dir_all(db_path())?;
        let table = self.conn().await?.create_empty_table(name, code_schema(dimensions)).execute().await?;
        let meta = serde_json::json!({ "chunk_id_scheme": CURRENT_CHUNK_ID_SCHEME, "chunk_id_scheme_introduced_in": "0.31.0" });
        std::fs::write(db_path().join(format!("{name}-meta.json")), serde_json::to_string_pretty(&meta)? + "\n")?;
        self.tables.lock().unwrap().insert(name.to_string(), table.clone());
        Ok(table)
    }

    /// `upsert`: mergeInsert on chunk_id.
    pub async fn upsert_code(&self, name: &str, rows: &[(Chunk, Vec<f32>)]) -> Result<()> {
        let Some(dim) = rows.first().map(|(_, v)| v.len() as i32) else { return Ok(()) };
        let table = self.open_or_create_code(name, dim).await?;
        let schema = code_schema(dim);
        let text = |f: &dyn Fn(&Chunk) -> String| -> ArrayRef { Arc::new(StringArray::from_iter_values(rows.iter().map(|(c, _)| f(c)))) };
        let flat: Vec<f32> = rows.iter().flat_map(|(_, v)| v.iter().copied()).collect();
        let vectors = FixedSizeListArray::try_new(Arc::new(Field::new("item", DataType::Float32, false)), dim, Arc::new(Float32Array::from(flat)), None)?;
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                text(&|c| c.chunk_id.clone()),
                text(&|c| c.project_id.clone()),
                text(&|c| c.item_path.clone()),
                text(&|c| c.content.clone()),
                Arc::new(Int32Array::from_iter_values(rows.iter().map(|(c, _)| c.start_line as i32))),
                Arc::new(Int32Array::from_iter_values(rows.iter().map(|(c, _)| c.end_line as i32))),
                text(&|c| c.language.clone()),
                text(&|c| c.symbol_name.clone()),
                Arc::new(vectors),
            ],
        )?;
        let mut merge = table.merge_insert(&["chunk_id"]);
        merge.when_matched_update_all(None).when_not_matched_insert_all();
        merge.execute(Box::new(RecordBatchIterator::new(vec![Ok(batch)], schema))).await?;
        Ok(())
    }

    /// `deleteProject`.
    pub async fn delete_project_rows(&self, name: &str, project: &str) -> Result<()> {
        if let Some(table) = self.open(name).await? {
            table.delete(format!("project_id = '{}'", escape_sql(project)).as_str()).await?;
        }
        Ok(())
    }

    /// `createFtsIndex`: skipped when a live keyword index is already there.
    pub async fn create_fts_index(&self, name: &str) -> Result<()> {
        let Some(table) = self.open(name).await? else { return Ok(()) };
        if table.count_rows(None).await? == 0 {
            return Ok(());
        }
        let in_manifest = table.list_indices().await?.iter().any(|i| i.index_type.to_string().to_uppercase().contains("FTS") && i.columns.iter().any(|c| c == "content"));
        let on_disk = std::fs::read_dir(db_path().join(format!("{name}.lance")).join("_indices")).map(|d| d.flatten().any(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))).unwrap_or(false);
        if in_manifest && on_disk {
            return Ok(());
        }
        let params = FtsIndexBuilder::default().stem(false).lower_case(true);
        table.create_index(&["content"], Index::FTS(params)).replace(true).execute().await?;
        Ok(())
    }

    /// `compactTableWithGrace`: merge fragments, prune versions older than the grace, refresh indexes.
    pub async fn compact_with_grace(&self, name: &str) -> Result<()> {
        let Some(table) = self.open(name).await? else { return Ok(()) };
        table.optimize(OptimizeAction::Compact { options: Default::default(), remap_options: None }).await?;
        table.optimize(OptimizeAction::Prune { older_than: Some(chrono::TimeDelta::seconds(60)), delete_unverified: None, error_if_tagged_old_versions: None }).await?;
        table.optimize(OptimizeAction::Index(Default::default())).await?;
        Ok(())
    }

    pub async fn plain_query(&self, table: &Table, where_: &str, limit: usize) -> Result<Rows> {
        let stream = table.query().only_if(where_).limit(limit).execute().await?;
        Ok(Rows { batches: stream.try_collect().await? })
    }
}
