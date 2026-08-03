#[tokio::main]
async fn main() {
    // PDF deliberadamente corrompido: header válido, corpo lixo.
    let bad = b"%PDF-1.7\n7 0 obj\n<< /Filter /FlateDecode /Length 99 >>\nstream\nNAO-E-ZLIB\nendstream\nendobj\ntrailer<<>>".to_vec();
    let r = tokio::task::spawn_blocking(move || pdf_extract::extract_text_from_mem(&bad)).await;
    match r {
        Ok(Ok(t)) => println!("OK texto: {} chars", t.len()),
        Ok(Err(e)) => println!("Err limpo: {e}"),
        Err(join) => println!("PANIC contido pelo spawn_blocking: {join}"),
    }
}
