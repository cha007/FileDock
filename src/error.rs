use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
    pub code: &'static str,
}

impl ApiError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            message: message.into(),
            code: "ERROR",
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }

    pub fn with_code(mut self, code: &'static str) -> Self {
        self.code = code;
        self
    }
}

impl From<std::io::Error> for ApiError {
    fn from(err: std::io::Error) -> Self {
        match err.kind() {
            std::io::ErrorKind::NotFound => Self::new(404, "文件或文件夹不存在"),
            std::io::ErrorKind::PermissionDenied => Self::new(403, "没有访问权限"),
            std::io::ErrorKind::AlreadyExists => Self::new(409, "目标已存在"),
            _ => Self::new(500, format!("文件操作失败：{}", err)),
        }
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(err: serde_json::Error) -> Self {
        Self::new(500, format!("数据解析失败：{}", err))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        if self.status.as_u16() >= 500 {
            eprintln!("[api] {} {}", self.status.as_u16(), self.message);
        }
        (
            self.status,
            Json(json!({ "error": self.message, "code": self.code })),
        )
            .into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
