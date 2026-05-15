//! Canonical JSON encoder.
//!
//! Matches the Node-side `canonicalJson` in `src/artifact.js`: sort object
//! keys lexicographically, omit whitespace, encode using the same escape
//! rules as `JSON.stringify`. The output is the exact byte sequence the Node
//! side HMACs, so chain links computed here are bit-identical.

use serde_json::Value;

/// Encode a JSON value in canonical form (sorted keys, no whitespace).
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write(&mut out, value);
    out
}

fn write(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&n.to_string()),
        Value::String(s) => {
            out.push('"');
            escape_string(out, s);
            out.push('"');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push('"');
                escape_string(out, key);
                out.push_str("\":");
                write(out, &map[key.as_str()]);
            }
            out.push('}');
        }
    }
}

fn escape_string(out: &mut String, s: &str) {
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\x08' => out.push_str("\\b"),
            '\x0c' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sorts_keys() {
        let v = json!({ "b": 1, "a": 2 });
        assert_eq!(canonical_json(&v), r#"{"a":2,"b":1}"#);
    }

    #[test]
    fn omits_whitespace() {
        let v = json!({ "a": [1, 2, 3] });
        assert_eq!(canonical_json(&v), r#"{"a":[1,2,3]}"#);
    }

    #[test]
    fn escapes_control_chars() {
        let v = json!({ "k": "\n\t\"" });
        assert_eq!(canonical_json(&v), r#"{"k":"\n\t\""}"#);
    }

    #[test]
    fn deterministic_across_runs() {
        let v = json!({ "z": 1, "a": 2, "m": { "y": 3, "b": 4 } });
        let a = canonical_json(&v);
        let b = canonical_json(&v);
        assert_eq!(a, b);
        assert_eq!(a, r#"{"a":2,"m":{"b":4,"y":3},"z":1}"#);
    }

    #[test]
    fn recurses_into_array_elements() {
        // Regression: the v10b first run shipped without array recursion and
        // produced unsorted keys inside array elements. Verify that nested
        // objects inside arrays are still canonicalized.
        let v = json!([
            { "z": 1, "a": 2 },
            { "y": 3, "b": 4 },
        ]);
        assert_eq!(
            canonical_json(&v),
            r#"[{"a":2,"z":1},{"b":4,"y":3}]"#
        );
    }

    #[test]
    fn recurses_into_deeply_nested_arrays() {
        let v = json!({
            "outer": [
                [ { "z": 1, "a": 2 } ],
                [ { "y": 3, "b": 4 } ],
            ],
        });
        assert_eq!(
            canonical_json(&v),
            r#"{"outer":[[{"a":2,"z":1}],[{"b":4,"y":3}]]}"#
        );
    }

    #[test]
    fn round_trip_via_serde_json() {
        // canonical_json must produce JSON serde_json can parse back into a
        // semantically equal value.
        let v = json!({
            "task": "spam-detect",
            "params": [1, 2, 3],
            "nested": { "z": true, "a": null },
        });
        let canon = canonical_json(&v);
        let parsed: serde_json::Value = serde_json::from_str(&canon).expect("round-trip");
        assert_eq!(parsed, v);
    }

    #[test]
    fn null_bool_number_primitives() {
        assert_eq!(canonical_json(&json!(null)), "null");
        assert_eq!(canonical_json(&json!(true)), "true");
        assert_eq!(canonical_json(&json!(false)), "false");
        assert_eq!(canonical_json(&json!(42)), "42");
        assert_eq!(canonical_json(&json!(-1.5)), "-1.5");
        assert_eq!(canonical_json(&json!("hi")), r#""hi""#);
    }

    #[test]
    fn empty_object_and_array() {
        assert_eq!(canonical_json(&json!({})), "{}");
        assert_eq!(canonical_json(&json!([])), "[]");
    }

    #[test]
    fn sorted_keys_lexicographic_not_locale() {
        // ASCII-only lexicographic order: 'A' < 'a' < 'b'
        let v = json!({ "b": 1, "A": 2, "a": 3 });
        assert_eq!(canonical_json(&v), r#"{"A":2,"a":3,"b":1}"#);
    }
}
