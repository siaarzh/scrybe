//! The client behind every request that leaves this machine, with the rules of Node's fetch: proxies only when
//! NODE_USE_ENV_PROXY asks for them, and the certificates NODE_EXTRA_CA_CERTS names trusted as well.
use reqwest::{Certificate, Client, ClientBuilder, NoProxy, Proxy};
use std::sync::OnceLock;

pub fn builder() -> ClientBuilder {
    let mut b = Client::builder().user_agent(crate::config::USER_AGENT).no_proxy();
    for p in proxies(|k| std::env::var(k).ok()) {
        b = b.proxy(p);
    }
    for c in extra_certs() {
        b = b.add_root_certificate(c.clone());
    }
    b
}

fn proxies(env: impl Fn(&str) -> Option<String>) -> Vec<Proxy> {
    if env("NODE_USE_ENV_PROXY").as_deref() != Some("1") {
        return vec![];
    }
    let pick = |lower: &str, upper: &str| env(lower).or_else(|| env(upper)).filter(|v| !v.is_empty());
    let http = pick("http_proxy", "HTTP_PROXY");
    let https = pick("https_proxy", "HTTPS_PROXY").or_else(|| http.clone());
    let skip = pick("no_proxy", "NO_PROXY").and_then(|v| NoProxy::from_string(&v));
    let made = [http.and_then(|u| Proxy::http(u).ok()), https.and_then(|u| Proxy::https(u).ok())];
    made.into_iter().flatten().map(|p| p.no_proxy(skip.clone())).collect()
}

fn extra_certs() -> &'static [Certificate] {
    static CERTS: OnceLock<Vec<Certificate>> = OnceLock::new();
    CERTS.get_or_init(|| {
        let Some(path) = std::env::var_os("NODE_EXTRA_CA_CERTS").filter(|p| !p.is_empty()) else { return vec![] };
        let (certs, problem) = match std::fs::read(&path) {
            Ok(pem) => parse_bundle(&String::from_utf8_lossy(&pem)),
            Err(e) => (vec![], Some(e.to_string())),
        };
        if let Some(problem) = problem {
            eprintln!("Warning: Ignoring extra certs from `{}`, load failed: {problem}", path.to_string_lossy());
        }
        certs
    })
}

/// The certificates up to the first one that can't be used, and what was wrong with it.
fn parse_bundle(pem: &str) -> (Vec<Certificate>, Option<String>) {
    const END: &str = "-----END CERTIFICATE-----";
    let mut certs = vec![];
    for part in pem.split_inclusive(END).filter(|p| p.ends_with(END)) {
        let one = match Certificate::from_pem_bundle(part.as_bytes()).map(|mut list| list.pop()) {
            Ok(Some(c)) => c,
            Ok(None) => return (certs, Some("no certificate in the file".into())),
            Err(e) => return (certs, Some(e.to_string())),
        };
        // Only building a client reads the certificate itself, and one bad certificate fails the whole client.
        if let Err(e) = Client::builder().no_proxy().tls_built_in_root_certs(false).add_root_certificate(one.clone()).build() {
            return (certs, Some(e.to_string()));
        }
        certs.push(one);
    }
    let problem = certs.is_empty().then(|| "no certificate in the file".to_string());
    (certs, problem)
}

/// `Response.json()`: a byte order mark is dropped, and text Rust can't hold is replaced.
pub async fn json_body(res: reqwest::Response) -> anyhow::Result<serde_json::Value> {
    let bytes = res.bytes().await.map_err(|e| anyhow::Error::new(e).context("Unexpected end of JSON input"))?;
    let text = String::from_utf8_lossy(&bytes);
    crate::jsstr::parse_json(text.strip_prefix('\u{FEFF}').unwrap_or(&text)).map_err(|e| anyhow::Error::new(e).context("Unexpected end of JSON input"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxies_are_used_only_when_node_would() {
        let set = |pairs: &'static [(&str, &str)]| move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string());
        assert_eq!(proxies(set(&[("HTTP_PROXY", "http://p:1"), ("https_proxy", "http://p:2"), ("ALL_PROXY", "http://p:3")])).len(), 0);
        assert_eq!(proxies(set(&[("NODE_USE_ENV_PROXY", "true"), ("HTTP_PROXY", "http://p:1")])).len(), 0);
        let both = proxies(set(&[("NODE_USE_ENV_PROXY", "1"), ("HTTP_PROXY", "http://upper:1"), ("http_proxy", "http://lower:1")]));
        assert_eq!(both.len(), 2, "with no proxy of its own https takes the http one");
        assert!(both.iter().all(|p| format!("{p:?}").contains("lower")), "{both:?}");
        assert_eq!(proxies(set(&[("NODE_USE_ENV_PROXY", "1"), ("ALL_PROXY", "http://p:3")])).len(), 0);
    }

    #[test]
    fn a_bundle_without_a_usable_certificate_is_a_problem_and_not_a_failure() {
        for text in ["", "not a certificate", "-----BEGIN CERTIFICATE-----\n!!!\n-----END CERTIFICATE-----\n", "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"] {
            let (certs, problem) = parse_bundle(text);
            assert!(certs.is_empty() && problem.is_some(), "{text:?}");
        }
        assert!(builder().build().is_ok());
    }
}
