use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    ActivationPolicy, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

const EXTENSION_SERVER_ADDR: &str = "127.0.0.1:39287";
const STORAGE_FILE_NAME: &str = "websites.json";
const WINDOW_PREFERENCES_FILE_NAME: &str = "window-preferences.json";
const BRIDGE_TOKEN_FILE_NAME: &str = "bridge-token";
const SETTINGS_MENU_ID: &str = "open_settings";
const CLOSE_WINDOW_MENU_ID: &str = "close_window";
const MAX_HTTP_REQUEST_BYTES: usize = 2 * 1024 * 1024;
const MAX_WEBSITE_NAME_CHARS: usize = 200;
const MAX_WEBSITE_URL_CHARS: usize = 2048;
const MAX_STORED_WEBSITES: usize = 1000;
const BRIDGE_RATE_LIMIT_WINDOW_MILLIS: u64 = 10_000;
const BRIDGE_RATE_LIMIT_MAX_REQUESTS: usize = 60;
const BRIDGE_TOKEN_LENGTH_BYTES: usize = 32;
const MAX_FALLBACK_PREVIEW_DATA_URL_CHARS: usize = 1_500_000;

#[derive(Serialize)]
struct BridgeTokenResponse<'a> {
    token: &'a str,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebsiteRecord {
    name: String,
    url: String,
    added_at: u64,
    #[serde(default)]
    fallback_preview_data_url: Option<String>,
    #[serde(default)]
    prefer_fallback_preview: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddWebsiteRequest {
    name: String,
    url: String,
    added_at: Option<u64>,
    fallback_preview_data_url: Option<String>,
    prefer_fallback_preview: Option<bool>,
}

struct StorageState {
    path: PathBuf,
    lock: Arc<Mutex<()>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowPreferences {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
}

struct WindowPreferencesState {
    path: PathBuf,
    lock: Arc<Mutex<()>>,
}

#[tauri::command]
fn list_websites(state: State<'_, StorageState>) -> Result<Vec<WebsiteRecord>, String> {
    read_websites(&state.path, &state.lock)
}

#[tauri::command]
fn add_website(
    name: String,
    url: String,
    state: State<'_, StorageState>,
) -> Result<Vec<WebsiteRecord>, String> {
    let (name, url) = validate_website_fields(&name, &url)?;

    add_website_record(
        &state.path,
        &state.lock,
        WebsiteRecord {
            name,
            url,
            added_at: current_timestamp_millis(),
            fallback_preview_data_url: None,
            prefer_fallback_preview: false,
        },
    )
}

#[tauri::command]
fn clear_website_fallback_preview(
    url: String,
    added_at: u64,
    state: State<'_, StorageState>,
) -> Result<Vec<WebsiteRecord>, String> {
    clear_website_fallback_preview_record(&state.path, &state.lock, &url, added_at)
}

#[tauri::command]
fn delete_website(
    url: String,
    added_at: u64,
    state: State<'_, StorageState>,
) -> Result<Vec<WebsiteRecord>, String> {
    delete_website_record(&state.path, &state.lock, &url, added_at)
}

#[tauri::command]
fn restore_website(
    website: WebsiteRecord,
    state: State<'_, StorageState>,
) -> Result<Vec<WebsiteRecord>, String> {
    restore_website_record(&state.path, &state.lock, website)
}

fn initialize_storage(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let app_data_dir = app.path().app_data_dir()?;
    fs::create_dir_all(&app_data_dir)?;

    let storage_path = app_data_dir.join(STORAGE_FILE_NAME);

    if !storage_path.exists() {
        let default_websites = vec![
            WebsiteRecord {
                name: "OpenAI".into(),
                url: "https://openai.com".into(),
                added_at: 1_776_733_200_000,
                fallback_preview_data_url: None,
                prefer_fallback_preview: false,
            },
            WebsiteRecord {
                name: "Tauri".into(),
                url: "https://tauri.app".into(),
                added_at: 1_776_732_300_000,
                fallback_preview_data_url: None,
                prefer_fallback_preview: false,
            },
            WebsiteRecord {
                name: "React".into(),
                url: "https://react.dev".into(),
                added_at: 1_776_731_400_000,
                fallback_preview_data_url: None,
                prefer_fallback_preview: false,
            },
            WebsiteRecord {
                name: "Vite".into(),
                url: "https://vite.dev".into(),
                added_at: 1_776_730_500_000,
                fallback_preview_data_url: None,
                prefer_fallback_preview: false,
            },
        ];

        write_websites_file(&storage_path, &default_websites)?;
    }

    Ok(storage_path)
}

fn initialize_window_preferences(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let app_data_dir = app.path().app_data_dir()?;
    fs::create_dir_all(&app_data_dir)?;

    Ok(app_data_dir.join(WINDOW_PREFERENCES_FILE_NAME))
}

fn initialize_bridge_token(app: &tauri::App) -> Result<String, Box<dyn std::error::Error>> {
    let app_data_dir = app.path().app_data_dir()?;
    fs::create_dir_all(&app_data_dir)?;
    let token_path = app_data_dir.join(BRIDGE_TOKEN_FILE_NAME);

    if token_path.exists() {
        let existing_token = fs::read_to_string(&token_path)?.trim().to_string();

        if !existing_token.is_empty() {
            return Ok(existing_token);
        }
    }

    let token = generate_bridge_token();
    fs::write(&token_path, format!("{token}\n"))?;

    Ok(token)
}

fn restore_window_preferences(app: &tauri::App, path: &PathBuf) {
    let Ok(file_contents) = fs::read_to_string(path) else {
        return;
    };
    let Ok(preferences) = serde_json::from_str::<WindowPreferences>(&file_contents) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
        preferences.width,
        preferences.height,
    )));
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        preferences.x,
        preferences.y,
    )));
}

fn save_window_preferences(window: &tauri::Window) {
    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let preferences = WindowPreferences {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
    };
    let preferences_state = window.state::<WindowPreferencesState>();
    let Ok(_guard) = preferences_state.lock.lock() else {
        return;
    };

    if let Ok(file_contents) = serde_json::to_string_pretty(&preferences) {
        let _ = fs::write(&preferences_state.path, format!("{file_contents}\n"));
    }
}

fn save_webview_window_preferences(window: &tauri::WebviewWindow) {
    let Ok(size) = window.outer_size() else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let preferences = WindowPreferences {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
    };
    let preferences_state = window.state::<WindowPreferencesState>();
    let Ok(_guard) = preferences_state.lock.lock() else {
        return;
    };

    if let Ok(file_contents) = serde_json::to_string_pretty(&preferences) {
        let _ = fs::write(&preferences_state.path, format!("{file_contents}\n"));
    }
}

fn configure_menu(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let settings_item = MenuItem::with_id(
        app,
        SETTINGS_MENU_ID,
        "Settings",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let close_window_item = MenuItem::with_id(
        app,
        CLOSE_WINDOW_MENU_ID,
        "Close Window",
        true,
        Some("CmdOrCtrl+W"),
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = PredefinedMenuItem::quit(app, None)?;
    let app_submenu = Submenu::with_items(
        app,
        "Agglomerator",
        true,
        &[&settings_item, &close_window_item, &separator, &quit_item],
    )?;
    let menu = Menu::with_items(app, &[&app_submenu])?;

    app.set_menu(menu)?;
    app.on_menu_event(|app_handle, event| {
        if event.id() == SETTINGS_MENU_ID {
            open_settings_window(app_handle);
        } else if event.id() == CLOSE_WINDOW_MENU_ID {
            close_focused_window(app_handle);
        }
    });

    Ok(())
}

fn open_settings_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let Ok(window) = WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("index.html#settings".into()),
    )
    .inner_size(520.0, 440.0)
    .min_inner_size(440.0, 360.0)
    .resizable(true)
    .focused(true)
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true)
    .build()
    else {
        return;
    };

    let _ = window.set_title("Settings");
}

fn close_focused_window(app: &tauri::AppHandle) {
    for window in app.webview_windows().values() {
        let Ok(is_focused) = window.is_focused() else {
            continue;
        };

        if !is_focused {
            continue;
        }

        if window.label() == "main" {
            save_webview_window_preferences(window);
            let _ = window.hide();
        } else {
            let _ = window.close();
        }

        break;
    }
}

fn read_websites(path: &PathBuf, lock: &Arc<Mutex<()>>) -> Result<Vec<WebsiteRecord>, String> {
    let _guard = lock
        .lock()
        .map_err(|_| "Storage lock is unavailable".to_string())?;
    read_websites_file(path)
}

fn read_websites_file(path: &PathBuf) -> Result<Vec<WebsiteRecord>, String> {
    let file_contents =
        fs::read_to_string(path).map_err(|error| format!("Unable to read websites: {error}"))?;

    serde_json::from_str(&file_contents)
        .map_err(|error| format!("Unable to parse websites JSON: {error}"))
}

fn add_website_record(
    path: &PathBuf,
    lock: &Arc<Mutex<()>>,
    record: WebsiteRecord,
) -> Result<Vec<WebsiteRecord>, String> {
    let _guard = lock
        .lock()
        .map_err(|_| "Storage lock is unavailable".to_string())?;
    let mut websites = read_websites_file(path)?;

    websites.push(record);
    websites.sort_by(|first, second| second.added_at.cmp(&first.added_at));
    websites.truncate(MAX_STORED_WEBSITES);
    write_websites_file(path, &websites)
        .map_err(|error| format!("Unable to write websites JSON: {error}"))?;

    Ok(websites)
}

fn clear_website_fallback_preview_record(
    path: &PathBuf,
    lock: &Arc<Mutex<()>>,
    url: &str,
    added_at: u64,
) -> Result<Vec<WebsiteRecord>, String> {
    let _guard = lock
        .lock()
        .map_err(|_| "Storage lock is unavailable".to_string())?;
    let mut websites = read_websites_file(path)?;

    if let Some(website) = websites
        .iter_mut()
        .find(|website| website.url == url && website.added_at == added_at)
    {
        website.fallback_preview_data_url = None;
        website.prefer_fallback_preview = false;
    }

    websites.sort_by(|first, second| second.added_at.cmp(&first.added_at));
    write_websites_file(path, &websites)
        .map_err(|error| format!("Unable to write websites JSON: {error}"))?;

    Ok(websites)
}

fn delete_website_record(
    path: &PathBuf,
    lock: &Arc<Mutex<()>>,
    url: &str,
    added_at: u64,
) -> Result<Vec<WebsiteRecord>, String> {
    let _guard = lock
        .lock()
        .map_err(|_| "Storage lock is unavailable".to_string())?;
    let mut websites = read_websites_file(path)?;

    websites.retain(|website| !(website.url == url && website.added_at == added_at));
    websites.sort_by(|first, second| second.added_at.cmp(&first.added_at));
    write_websites_file(path, &websites)
        .map_err(|error| format!("Unable to write websites JSON: {error}"))?;

    Ok(websites)
}

fn restore_website_record(
    path: &PathBuf,
    lock: &Arc<Mutex<()>>,
    record: WebsiteRecord,
) -> Result<Vec<WebsiteRecord>, String> {
    let _guard = lock
        .lock()
        .map_err(|_| "Storage lock is unavailable".to_string())?;
    let mut websites = read_websites_file(path)?;

    websites.retain(|website| {
        !(website.url == record.url && website.added_at == record.added_at)
    });
    websites.push(record);
    websites.sort_by(|first, second| second.added_at.cmp(&first.added_at));
    websites.truncate(MAX_STORED_WEBSITES);
    write_websites_file(path, &websites)
        .map_err(|error| format!("Unable to write websites JSON: {error}"))?;

    Ok(websites)
}

fn write_websites_file(
    path: &PathBuf,
    websites: &[WebsiteRecord],
) -> Result<(), Box<dyn std::error::Error>> {
    let file_contents = serde_json::to_string_pretty(websites)?;

    fs::write(path, format!("{file_contents}\n"))?;

    Ok(())
}

fn current_timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn generate_bridge_token() -> String {
    let mut random_bytes = [0_u8; BRIDGE_TOKEN_LENGTH_BYTES];
    OsRng.fill_bytes(&mut random_bytes);

    random_bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn validate_fallback_preview_data_url(
    fallback_preview_data_url: Option<String>,
) -> Result<Option<String>, String> {
    let Some(fallback_preview_data_url) = fallback_preview_data_url else {
        return Ok(None);
    };
    let trimmed_data_url = fallback_preview_data_url.trim();

    if trimmed_data_url.is_empty() {
        return Ok(None);
    }

    if trimmed_data_url.len() > MAX_FALLBACK_PREVIEW_DATA_URL_CHARS {
        return Err("Fallback preview was too large".to_string());
    }

    if !trimmed_data_url.starts_with("data:image/jpeg;base64,") {
        return Err("Fallback preview format was invalid".to_string());
    }

    Ok(Some(trimmed_data_url.to_string()))
}

fn parse_content_length(request_headers: &str) -> Result<usize, String> {
    for line in request_headers.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };

        if !name.trim().eq_ignore_ascii_case("content-length") {
            continue;
        }

        let parsed_length = value
            .trim()
            .parse::<usize>()
            .map_err(|_| "Invalid Content-Length".to_string())?;

        return Ok(parsed_length);
    }

    Ok(0)
}

fn find_header_boundary(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|offset| offset + 4)
}

fn read_http_request(stream: &mut TcpStream) -> Result<String, String> {
    let mut request_bytes = Vec::with_capacity(2048);
    let mut buffer = [0_u8; 1024];
    let mut expected_total_length: Option<usize> = None;

    loop {
        let bytes_read = stream
            .read(&mut buffer)
            .map_err(|error| format!("Unable to read extension request: {error}"))?;

        if bytes_read == 0 {
            break;
        }

        request_bytes.extend_from_slice(&buffer[..bytes_read]);

        if request_bytes.len() > MAX_HTTP_REQUEST_BYTES {
            return Err("Request too large".to_string());
        }

        if expected_total_length.is_none() {
            if let Some(headers_end) = find_header_boundary(&request_bytes) {
                let request_headers = std::str::from_utf8(&request_bytes[..headers_end])
                    .map_err(|_| "Request was not valid UTF-8".to_string())?;
                let body_length = parse_content_length(request_headers)?;

                if headers_end + body_length > MAX_HTTP_REQUEST_BYTES {
                    return Err("Request too large".to_string());
                }

                expected_total_length = Some(headers_end + body_length);
            }
        }

        if let Some(total_length) = expected_total_length {
            if request_bytes.len() >= total_length {
                request_bytes.truncate(total_length);
                break;
            }
        }
    }

    if request_bytes.is_empty() {
        return Err("Request was empty".to_string());
    }

    String::from_utf8(request_bytes).map_err(|_| "Request was not valid UTF-8".to_string())
}

fn extract_header_value(request: &str, header_name: &str) -> Option<String> {
    request.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if !name.trim().eq_ignore_ascii_case(header_name) {
            return None;
        }

        Some(value.trim().to_string())
    })
}

fn is_allowed_extension_origin(origin: &str) -> bool {
    origin.starts_with("moz-extension://")
        && origin.len() > "moz-extension://".len()
        && !origin.contains('\r')
        && !origin.contains('\n')
}

fn is_rate_limited(rate_limit: &Arc<Mutex<VecDeque<u64>>>) -> bool {
    let now = current_timestamp_millis();
    let Ok(mut history) = rate_limit.lock() else {
        return true;
    };

    while let Some(first_seen) = history.front() {
        if now.saturating_sub(*first_seen) > BRIDGE_RATE_LIMIT_WINDOW_MILLIS {
            history.pop_front();
        } else {
            break;
        }
    }

    if history.len() >= BRIDGE_RATE_LIMIT_MAX_REQUESTS {
        return true;
    }

    history.push_back(now);
    false
}

fn is_allowed_url(url: &str) -> bool {
    let trimmed_url = url.trim();
    if trimmed_url.is_empty() {
        return false;
    }

    let normalized_url = if trimmed_url.contains("://") {
        trimmed_url.to_string()
    } else {
        format!("https://{trimmed_url}")
    };

    let Some((scheme, _)) = normalized_url.split_once("://") else {
        return false;
    };

    matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https")
}

fn validate_website_fields(name: &str, url: &str) -> Result<(String, String), String> {
    let trimmed_name = name.trim();
    let trimmed_url = url.trim();

    if trimmed_name.is_empty() || trimmed_url.is_empty() {
        return Err("Name and URL are required".to_string());
    }

    if trimmed_name.chars().count() > MAX_WEBSITE_NAME_CHARS {
        return Err(format!("Name must be at most {MAX_WEBSITE_NAME_CHARS} characters"));
    }

    if trimmed_url.chars().count() > MAX_WEBSITE_URL_CHARS {
        return Err(format!("URL must be at most {MAX_WEBSITE_URL_CHARS} characters"));
    }

    if !is_allowed_url(trimmed_url) {
        return Err("Only http and https URLs are allowed".to_string());
    }

    Ok((trimmed_name.to_string(), trimmed_url.to_string()))
}

fn start_extension_server(
    path: PathBuf,
    lock: Arc<Mutex<()>>,
    bridge_token: String,
    rate_limit: Arc<Mutex<VecDeque<u64>>>,
) {
    thread::spawn(move || {
        let listener = match TcpListener::bind(EXTENSION_SERVER_ADDR) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("Unable to start extension bridge: {error}");
                return;
            }
        };

        for stream in listener.incoming().flatten() {
            handle_extension_request(stream, &path, &lock, &bridge_token, &rate_limit);
        }
    });
}

fn handle_extension_request(
    mut stream: TcpStream,
    path: &PathBuf,
    lock: &Arc<Mutex<()>>,
    bridge_token: &str,
    rate_limit: &Arc<Mutex<VecDeque<u64>>>,
) {
    let request = match read_http_request(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            write_http_response(
                &mut stream,
                400,
                &format!("{{\"error\":\"{error}\"}}"),
                None,
            );
            return;
        }
    };

    if is_rate_limited(rate_limit) {
        write_http_response(
            &mut stream,
            429,
            "{\"error\":\"Too many requests\"}",
            None,
        );
        return;
    }

    let request_line = request.lines().next().unwrap_or_default();
    let mut request_line_parts = request_line.split_whitespace();
    let method = request_line_parts.next().unwrap_or_default();
    let request_path = request_line_parts.next().unwrap_or_default();
    let origin_header = extract_header_value(&request, "Origin");
    let allowed_origin = origin_header
        .as_deref()
        .filter(|origin| is_allowed_extension_origin(origin));

    if method == "OPTIONS" {
        if let Some(origin) = allowed_origin {
            write_http_response(&mut stream, 204, "", Some(origin));
        } else {
            write_http_response(&mut stream, 403, "{\"error\":\"Forbidden origin\"}", None);
        }
        return;
    }

    if allowed_origin.is_none() {
        write_http_response(&mut stream, 403, "{\"error\":\"Forbidden origin\"}", None);
        return;
    }
    let allowed_origin = allowed_origin.unwrap_or_default();

    if method == "GET" && request_path == "/bridge-token" {
        let token_response = serde_json::to_string(&BridgeTokenResponse {
            token: bridge_token,
        })
        .unwrap_or_else(|_| "{\"error\":\"Unable to serialize token\"}".to_string());
        write_http_response(&mut stream, 200, &token_response, Some(allowed_origin));
        return;
    }

    if method != "POST" || request_path != "/websites" {
        write_http_response(&mut stream, 404, "{\"error\":\"Not found\"}", Some(allowed_origin));
        return;
    }

    let token_header = extract_header_value(&request, "X-Agglomerator-Token").unwrap_or_default();
    if token_header != bridge_token {
        write_http_response(
            &mut stream,
            401,
            "{\"error\":\"Unauthorized\"}",
            Some(allowed_origin),
        );
        return;
    }

    let Some((_, body)) = request.split_once("\r\n\r\n") else {
        write_http_response(
            &mut stream,
            400,
            "{\"error\":\"Missing request body\"}",
            Some(allowed_origin),
        );
        return;
    };

    let request_body = match serde_json::from_str::<AddWebsiteRequest>(body.trim()) {
        Ok(request_body) => request_body,
        Err(_) => {
            write_http_response(
                &mut stream,
                400,
                "{\"error\":\"Invalid JSON\"}",
                Some(allowed_origin),
            );
            return;
        }
    };

    let (name, url) = match validate_website_fields(&request_body.name, &request_body.url) {
        Ok(fields) => fields,
        Err(error) => {
            write_http_response(
                &mut stream,
                400,
                &format!("{{\"error\":\"{error}\"}}"),
                Some(allowed_origin),
            );
            return;
        }
    };

    let fallback_preview_data_url =
        match validate_fallback_preview_data_url(request_body.fallback_preview_data_url) {
            Ok(fallback_preview_data_url) => fallback_preview_data_url,
            Err(error) => {
                write_http_response(
                    &mut stream,
                    400,
                    &format!("{{\"error\":\"{error}\"}}"),
                    Some(allowed_origin),
                );
                return;
            }
        };

    let record = WebsiteRecord {
        name,
        url,
        added_at: request_body
            .added_at
            .unwrap_or_else(current_timestamp_millis),
        fallback_preview_data_url,
        prefer_fallback_preview: request_body.prefer_fallback_preview.unwrap_or(false),
    };

    match add_website_record(path, lock, record) {
        Ok(websites) => {
            let response_body = serde_json::to_string(&websites).unwrap_or_else(|_| "[]".into());
            write_http_response(&mut stream, 200, &response_body, Some(allowed_origin));
        }
        Err(error) => {
            let response_body = format!("{{\"error\":\"{error}\"}}");
            write_http_response(&mut stream, 500, &response_body, Some(allowed_origin));
        }
    }
}

fn write_http_response(
    stream: &mut TcpStream,
    status_code: u16,
    body: &str,
    allow_origin: Option<&str>,
) {
    let status_text = match status_code {
        200 => "OK",
        204 => "No Content",
        401 => "Unauthorized",
        403 => "Forbidden",
        429 => "Too Many Requests",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let mut headers = format!(
        "HTTP/1.1 {status_code} {status_text}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n",
        body.len(),
    );

    if let Some(origin) = allow_origin {
        headers.push_str(&format!(
            "Access-Control-Allow-Origin: {origin}\r\n\
             Access-Control-Allow-Headers: content-type, x-agglomerator-token\r\n\
             Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
             Vary: Origin\r\n",
        ));
    }

    headers.push_str("\r\n");
    headers.push_str(body);

    let _ = stream.write_all(headers.as_bytes());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.set_dock_visibility(true);
            app.set_activation_policy(ActivationPolicy::Regular);
            configure_menu(app)?;

            let storage_path = initialize_storage(app)?;
            let storage_lock = Arc::new(Mutex::new(()));
            let window_preferences_path = initialize_window_preferences(app)?;
            let window_preferences_lock = Arc::new(Mutex::new(()));
            let bridge_token = initialize_bridge_token(app)?;
            let bridge_rate_limit = Arc::new(Mutex::new(VecDeque::new()));

            app.manage(StorageState {
                path: storage_path.clone(),
                lock: Arc::clone(&storage_lock),
            });
            app.manage(WindowPreferencesState {
                path: window_preferences_path.clone(),
                lock: Arc::clone(&window_preferences_lock),
            });

            restore_window_preferences(app, &window_preferences_path);
            start_extension_server(storage_path, storage_lock, bridge_token, bridge_rate_limit);

            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "main" {
                    api.prevent_close();
                    save_window_preferences(window);
                    let _ = window.hide();
                }
            }
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                if window.label() == "main" {
                    save_window_preferences(window);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            list_websites,
            add_website,
            delete_website,
            clear_website_fallback_preview,
            restore_website
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = event
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
}
