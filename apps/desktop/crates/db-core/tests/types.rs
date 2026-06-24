use db_core::{CellValue, QueryHandle, QueryLang};

#[test]
fn query_handle_is_unique() {
    let a = QueryHandle::new();
    let b = QueryHandle::new();
    assert_ne!(a, b);
}

#[test]
fn cell_value_round_trips_through_json() {
    let v = vec![
        CellValue::Null,
        CellValue::Bool(true),
        CellValue::Int(42),
        CellValue::Float(1.5),
        CellValue::Text("hi".into()),
        CellValue::Raw("123.456".into()),
        CellValue::Document(serde_json::json!({"k": [1, 2]})),
        CellValue::Bytes(vec![1, 2, 3]),
    ];
    let s = serde_json::to_string(&v).unwrap();
    let back: Vec<CellValue> = serde_json::from_str(&s).unwrap();
    assert_eq!(back.len(), v.len());
    // Bytes equality: roundtrip preserves length and content.
    if let CellValue::Bytes(bs) = &back[7] {
        assert_eq!(bs, &vec![1, 2, 3]);
    } else {
        panic!("expected Bytes");
    }
}

#[test]
fn query_lang_serializes_snake_case() {
    let s = serde_json::to_string(&QueryLang::MongoShell).unwrap();
    assert_eq!(s, "\"mongo_shell\"");
}
