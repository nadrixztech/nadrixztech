#!/usr/bin/env python3
"""NADRIX PWA and SQLite API server (Python standard library only)."""

import argparse
import hashlib
import hmac
import json
import logging
import mimetypes
import os
import re
import secrets
import sqlite3
import sys
import time
from http.cookies import SimpleCookie
from pathlib import Path
from urllib.parse import unquote
from wsgiref.simple_server import make_server


ROOT = Path(__file__).resolve().parent
COOKIE_NAME = "nadrix_session"
SESSION_SECONDS = 60 * 60 * 24 * 7
PASSWORD_ITERATIONS = 310_000
MAX_REQUEST_BYTES = 16_384
SERVICE_SEEDS = (
    ("Business Website", "Responsive websites for your business."),
    ("College Project", "Project support for students."),
    ("Custom Development", "Custom applications, dashboards, and integrations."),
    ("E-commerce", "Online stores and e-commerce solutions."),
    ("Web App", "Interactive web applications."),
    ("IT Services", "Hosting, domains, maintenance, and support."),
)
ORDER_STATUSES = {"new", "in_progress", "completed", "cancelled"}
LOGGER = logging.getLogger("nadrix")


class APIError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def _password_hash(password, salt):
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS
    )


class NadrixApplication:
    def __init__(self, database_path):
        self.database_path = Path(database_path).resolve()
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.login_attempts = {}
        self._initialize_database()

    def _connect(self):
        connection = sqlite3.connect(self.database_path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    def _initialize_database(self):
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY,
                    username TEXT NOT NULL UNIQUE,
                    email TEXT NOT NULL UNIQUE,
                    password_hash BLOB NOT NULL,
                    password_salt BLOB NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('customer', 'student', 'admin')),
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS services (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    description TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    csrf_token TEXT NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS orders (
                    id INTEGER PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id),
                    service_id INTEGER NOT NULL REFERENCES services(id),
                    details TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'new'
                        CHECK (status IN ('new', 'in_progress', 'completed', 'cancelled')),
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
                CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id, created_at);
                """
            )
            connection.executemany(
                "INSERT OR IGNORE INTO services (name, description) VALUES (?, ?)",
                SERVICE_SEEDS,
            )

    def create_admin(self, username, email, password):
        username = username.strip().lower()
        email = email.strip().lower()
        if not re.fullmatch(r"[a-z0-9._-]{3,30}", username):
            raise ValueError("Username must be 3–30 letters, numbers, dots, dashes, or underscores.")
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            raise ValueError("Enter a valid email address.")
        if len(password) < 12 or len(password) > 128:
            raise ValueError("Password must contain 12–128 characters.")
        salt = secrets.token_bytes(16)
        with self._connect() as connection:
            connection.execute(
                """INSERT INTO users
                   (username, email, password_hash, password_salt, role, created_at)
                   VALUES (?, ?, ?, ?, 'admin', ?)""",
                (username, email, _password_hash(password, salt), salt, int(time.time())),
            )

    def _json(self, start_response, status, payload, extra_headers=()):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Content-Length", str(len(body))),
            ("Cache-Control", "no-store"),
        ]
        headers.extend(extra_headers)
        self._security_headers(headers)
        start_response(f"{status} {self._status_text(status)}", headers)
        return [body]

    @staticmethod
    def _status_text(status):
        return {
            200: "OK",
            201: "Created",
            204: "No Content",
            400: "Bad Request",
            401: "Unauthorized",
            403: "Forbidden",
            404: "Not Found",
            405: "Method Not Allowed",
            409: "Conflict",
            413: "Payload Too Large",
            415: "Unsupported Media Type",
            429: "Too Many Requests",
            500: "Internal Server Error",
        }.get(status, "Error")

    @staticmethod
    def _security_headers(headers):
        headers.extend(
            [
                ("X-Content-Type-Options", "nosniff"),
                ("X-Frame-Options", "DENY"),
                ("Referrer-Policy", "strict-origin-when-cross-origin"),
                ("Permissions-Policy", "camera=(), microphone=(), geolocation=()"),
            ]
        )

    def _body(self, environ):
        try:
            length = int(environ.get("CONTENT_LENGTH") or "0")
        except ValueError as error:
            raise APIError(400, "Invalid Content-Length.") from error
        if length < 0:
            raise APIError(400, "Invalid Content-Length.")
        if length > MAX_REQUEST_BYTES:
            raise APIError(413, "Request body is too large.")
        if not length:
            return {}
        if environ.get("CONTENT_TYPE", "").split(";", 1)[0].strip().lower() != "application/json":
            raise APIError(415, "Send JSON with Content-Type: application/json.")
        raw_body = environ["wsgi.input"].read(length)
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
            raise APIError(400, "Request body must be valid JSON.") from error
        if not isinstance(payload, dict):
            raise APIError(400, "Request body must be a JSON object.")
        values = [payload]
        while values:
            value = values.pop()
            if isinstance(value, str):
                try:
                    value.encode("utf-8")
                except UnicodeEncodeError as error:
                    raise APIError(400, "Text fields must contain valid Unicode.") from error
            elif isinstance(value, dict):
                values.extend(value.keys())
                values.extend(value.values())
            elif isinstance(value, list):
                values.extend(value)
        return payload

    @staticmethod
    def _user_payload(user):
        return {
            "id": user["id"],
            "username": user["username"],
            "email": user["email"],
            "role": user["role"],
        }

    def _session(self, environ):
        cookie = SimpleCookie()
        cookie.load(environ.get("HTTP_COOKIE", ""))
        morsel = cookie.get(COOKIE_NAME)
        if not morsel:
            return None
        token_hash = hashlib.sha256(morsel.value.encode("utf-8")).hexdigest()
        now = int(time.time())
        with self._connect() as connection:
            row = connection.execute(
                """SELECT sessions.csrf_token, users.id, users.username, users.email, users.role
                   FROM sessions JOIN users ON users.id = sessions.user_id
                   WHERE sessions.token_hash = ? AND sessions.expires_at > ?""",
                (token_hash, now),
            ).fetchone()
            if row:
                return {"user": self._user_payload(row), "csrf_token": row["csrf_token"], "token_hash": token_hash}
            connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
        return None

    def _set_session(self, user_id, environ):
        token = secrets.token_urlsafe(32)
        csrf_token = secrets.token_urlsafe(32)
        expires_at = int(time.time()) + SESSION_SECONDS
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        secure = "; Secure" if environ.get("wsgi.url_scheme") == "https" else ""
        cookie_header = (
            f"{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; "
            f"Max-Age={SESSION_SECONDS}{secure}"
        )
        with self._connect() as connection:
            connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(time.time()),))
            connection.execute(
                "INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)",
                (token_hash, user_id, csrf_token, expires_at),
            )
            user = connection.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return user, csrf_token, ("Set-Cookie", cookie_header)

    def _require_user(self, session):
        if not session:
            raise APIError(401, "Sign in to continue.")
        return session["user"]

    @staticmethod
    def _require_csrf(environ, session):
        submitted = environ.get("HTTP_X_CSRF_TOKEN", "")
        if not session or not submitted or not hmac.compare_digest(submitted, session["csrf_token"]):
            raise APIError(403, "Your session expired. Refresh the page and try again.")

    @staticmethod
    def _require_admin(user):
        if user["role"] != "admin":
            raise APIError(403, "Administrator access is required.")

    def _api(self, environ, start_response, session):
        method = environ["REQUEST_METHOD"].upper()
        path = environ.get("PATH_INFO", "/")

        if path == "/api/health" and method == "GET":
            with self._connect() as connection:
                connection.execute("SELECT 1").fetchone()
            return self._json(start_response, 200, {"status": "ok"})

        if path == "/api/services" and method == "GET":
            with self._connect() as connection:
                services = connection.execute(
                    "SELECT id, name, description FROM services ORDER BY id"
                ).fetchall()
            return self._json(start_response, 200, {"services": [dict(row) for row in services]})

        if path == "/api/session" and method == "GET":
            return self._json(
                start_response,
                200,
                {
                    "user": session["user"] if session else None,
                    "csrf_token": session["csrf_token"] if session else None,
                },
            )

        if path == "/api/auth/signup" and method == "POST":
            data = self._body(environ)
            username = data.get("username")
            email = data.get("email")
            password = data.get("password")
            role = data.get("role")
            if not all(isinstance(value, str) for value in (username, email, password)):
                raise APIError(400, "Enter a username, email address, and password.")
            username = username.strip().lower()
            email = email.strip().lower()
            if not re.fullmatch(r"[a-z0-9._-]{3,30}", username):
                raise APIError(400, "Username must be 3–30 letters, numbers, dots, dashes, or underscores.")
            if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
                raise APIError(400, "Enter a valid email address.")
            if len(email) > 254:
                raise APIError(400, "Email addresses must be 254 characters or fewer.")
            if len(password) < 12 or len(password) > 128:
                raise APIError(400, "Password must contain 12–128 characters.")
            if not isinstance(role, str) or role not in {"customer", "student"}:
                raise APIError(400, "Choose Customer or Student. Admin accounts must be created by an administrator.")
            salt = secrets.token_bytes(16)
            try:
                with self._connect() as connection:
                    cursor = connection.execute(
                        """INSERT INTO users
                           (username, email, password_hash, password_salt, role, created_at)
                           VALUES (?, ?, ?, ?, ?, ?)""",
                        (username, email, _password_hash(password, salt), salt, role, int(time.time())),
                    )
                    user_id = cursor.lastrowid
            except sqlite3.IntegrityError as error:
                raise APIError(409, "That username or email is already registered.") from error
            user, csrf_token, cookie_header = self._set_session(user_id, environ)
            return self._json(
                start_response,
                201,
                {"user": self._user_payload(user), "csrf_token": csrf_token},
                (cookie_header,),
            )

        if path == "/api/auth/login" and method == "POST":
            data = self._body(environ)
            identity = data.get("identity")
            password = data.get("password")
            if not isinstance(identity, str) or not isinstance(password, str):
                raise APIError(400, "Enter your username or email address and password.")
            identity = identity.strip().lower()
            if not identity or len(identity) > 254 or len(password) > 128:
                raise APIError(400, "Check your username, email address, or password length.")
            client = environ.get("REMOTE_ADDR", "unknown")
            now = time.time()
            attempts = [attempt for attempt in self.login_attempts.get(client, []) if now - attempt < 300]
            self.login_attempts[client] = attempts
            if len(attempts) >= 10:
                raise APIError(429, "Too many sign-in attempts. Try again in a few minutes.")
            with self._connect() as connection:
                user = connection.execute(
                    "SELECT * FROM users WHERE username = ? OR email = ?",
                    (identity, identity),
                ).fetchone()
            valid = user and hmac.compare_digest(
                _password_hash(password, user["password_salt"]), user["password_hash"]
            )
            if not valid:
                attempts.append(now)
                self.login_attempts[client] = attempts
                raise APIError(401, "Username or password is incorrect.")
            self.login_attempts.pop(client, None)
            user, csrf_token, cookie_header = self._set_session(user["id"], environ)
            return self._json(
                start_response,
                200,
                {"user": self._user_payload(user), "csrf_token": csrf_token},
                (cookie_header,),
            )

        if path == "/api/auth/logout" and method == "POST":
            self._require_user(session)
            self._require_csrf(environ, session)
            with self._connect() as connection:
                connection.execute("DELETE FROM sessions WHERE token_hash = ?", (session["token_hash"],))
            return self._json(
                start_response,
                200,
                {"message": "Signed out."},
                (("Set-Cookie", f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"),),
            )

        if path == "/api/orders" and method == "GET":
            user = self._require_user(session)
            with self._connect() as connection:
                if user["role"] == "admin":
                    rows = connection.execute(
                        """SELECT orders.id, orders.details, orders.status, orders.created_at,
                                  services.name AS service, users.username
                           FROM orders JOIN services ON services.id = orders.service_id
                           JOIN users ON users.id = orders.user_id
                           ORDER BY orders.created_at DESC LIMIT 100"""
                    ).fetchall()
                else:
                    rows = connection.execute(
                        """SELECT orders.id, orders.details, orders.status, orders.created_at,
                                  services.name AS service
                           FROM orders JOIN services ON services.id = orders.service_id
                           WHERE orders.user_id = ? ORDER BY orders.created_at DESC LIMIT 100""",
                        (user["id"],),
                    ).fetchall()
            return self._json(start_response, 200, {"orders": [dict(row) for row in rows]})

        if path == "/api/orders" and method == "POST":
            user = self._require_user(session)
            self._require_csrf(environ, session)
            data = self._body(environ)
            details = data.get("details")
            if not isinstance(details, str):
                raise APIError(400, "Describe the service you need.")
            details = details.strip()
            raw_service_id = data.get("service_id")
            if isinstance(raw_service_id, bool) or not isinstance(raw_service_id, (int, str)):
                raise APIError(400, "Choose a valid service.")
            try:
                service_id = int(raw_service_id)
            except (TypeError, ValueError) as error:
                raise APIError(400, "Choose a valid service.") from error
            if isinstance(raw_service_id, str) and not raw_service_id.isdecimal():
                raise APIError(400, "Choose a valid service.")
            if not 1 <= service_id <= 9_223_372_036_854_775_807:
                raise APIError(400, "Choose a valid service.")
            if len(details) < 10 or len(details) > 2000:
                raise APIError(400, "Project details must contain 10–2000 characters.")
            with self._connect() as connection:
                service = connection.execute("SELECT id FROM services WHERE id = ?", (service_id,)).fetchone()
                if not service:
                    raise APIError(400, "Choose a valid service.")
                cursor = connection.execute(
                    "INSERT INTO orders (user_id, service_id, details, created_at) VALUES (?, ?, ?, ?)",
                    (user["id"], service_id, details, int(time.time())),
                )
            return self._json(start_response, 201, {"order": {"id": cursor.lastrowid, "status": "new"}})

        if path == "/api/admin/summary" and method == "GET":
            user = self._require_user(session)
            self._require_admin(user)
            with self._connect() as connection:
                summary = connection.execute(
                    """SELECT
                       (SELECT COUNT(*) FROM users WHERE role != 'admin') AS users,
                       (SELECT COUNT(*) FROM orders) AS orders,
                       (SELECT COUNT(*) FROM services) AS services,
                       (SELECT COUNT(*) FROM orders WHERE status = 'new') AS new_orders"""
                ).fetchone()
            return self._json(start_response, 200, {"summary": dict(summary)})

        if path.startswith("/api/admin/orders/") and method == "PATCH":
            user = self._require_user(session)
            self._require_admin(user)
            self._require_csrf(environ, session)
            order_id = path.rsplit("/", 1)[-1]
            if not order_id.isdigit() or len(order_id) > 19 or int(order_id) > 9_223_372_036_854_775_807:
                raise APIError(400, "Choose a valid order.")
            status = self._body(environ).get("status")
            if not isinstance(status, str) or status not in ORDER_STATUSES:
                raise APIError(400, "Choose a valid order status.")
            with self._connect() as connection:
                cursor = connection.execute(
                    "UPDATE orders SET status = ? WHERE id = ?", (status, int(order_id))
                )
                if cursor.rowcount == 0:
                    raise APIError(404, "Order not found.")
            return self._json(start_response, 200, {"order": {"id": int(order_id), "status": status}})

        if path.startswith("/api/"):
            allowed = self._allowed_method(path)
            if allowed:
                return self._json(
                    start_response,
                    405,
                    {"error": "Method not allowed."},
                    (("Allow", ", ".join(allowed)),),
                )
            raise APIError(404, "API endpoint not found.")

        return None

    @staticmethod
    def _allowed_method(path):
        methods = {
            "/api/health": {"GET"},
            "/api/services": {"GET"},
            "/api/session": {"GET"},
            "/api/auth/signup": {"POST"},
            "/api/auth/login": {"POST"},
            "/api/auth/logout": {"POST"},
            "/api/orders": {"GET", "POST"},
            "/api/admin/summary": {"GET"},
        }
        if path.startswith("/api/admin/orders/"):
            return {"PATCH"}
        return methods.get(path)

    def _static(self, environ, start_response):
        method = environ["REQUEST_METHOD"].upper()
        if method not in {"GET", "HEAD"}:
            return self._json(
                start_response,
                405,
                {"error": "Method not allowed."},
                (("Allow", "GET, HEAD"),),
            )

        path = unquote(environ.get("PATH_INFO", "/"))
        if path in {"/", "/index.html"}:
            path = "/nadrix.html"
        if path.startswith("/"):
            path = path[1:]
        if not path or any(part.startswith(".") for part in Path(path).parts):
            raise APIError(404, "File not found.")
        target = (ROOT / path).resolve()
        try:
            target.relative_to(ROOT)
            body = target.read_bytes()
        except (ValueError, FileNotFoundError, IsADirectoryError) as error:
            raise APIError(404, "File not found.") from error

        headers = [
            ("Content-Type", mimetypes.guess_type(str(target))[0] or "application/octet-stream"),
            ("Content-Length", str(len(body))),
            ("X-Content-Type-Options", "nosniff"),
            ("X-Frame-Options", "DENY"),
            ("Referrer-Policy", "strict-origin-when-cross-origin"),
        ]
        if target.name in {"nadrix.html", "service-worker.js"}:
            headers.append(("Cache-Control", "no-cache"))
        else:
            headers.append(("Cache-Control", "public, max-age=3600"))
        start_response("200 OK", headers)
        return [b"" if method == "HEAD" else body]

    def __call__(self, environ, start_response):
        try:
            session = self._session(environ)
            result = self._api(environ, start_response, session)
            if result is not None:
                return result
            return self._static(environ, start_response)
        except APIError as error:
            return self._json(start_response, error.status, {"error": error.message})
        except sqlite3.Error:
            LOGGER.exception("Database request failed")
            return self._json(start_response, 500, {"error": "The database request failed."})
        except OSError:
            LOGGER.exception("File or database operation failed")
            return self._json(start_response, 500, {"error": "The server could not complete the request."})


def _create_admin(app):
    username = input("Admin username: ").strip()
    email = input("Admin email: ").strip()
    import getpass

    password = getpass.getpass("Admin password (12+ characters): ")
    confirmation = getpass.getpass("Confirm password: ")
    if password != confirmation:
        raise ValueError("Passwords do not match.")
    app.create_admin(username, email, password)
    print("Administrator account created.")


def main():
    parser = argparse.ArgumentParser(description="Run the NADRIX website, PWA, and API.")
    parser.add_argument("--host", default=os.environ.get("NADRIX_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("NADRIX_PORT", "8000")))
    parser.add_argument("--database", default=os.environ.get("NADRIX_DATABASE", str(ROOT / "data" / "nadrix.sqlite3")))
    parser.add_argument("command", nargs="?", choices=("serve", "create-admin"), default="serve")
    args = parser.parse_args()
    app = NadrixApplication(args.database)

    if args.command == "create-admin":
        try:
            _create_admin(app)
        except (ValueError, sqlite3.IntegrityError) as error:
            print(f"Could not create administrator: {error}", file=sys.stderr)
            raise SystemExit(1)
        return

    LOGGER.info("Serving NADRIX on http://%s:%s", args.host, args.port)
    with make_server(args.host, args.port, app) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            LOGGER.info("NADRIX server stopped.")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    main()


_default_application = None


def application(environ, start_response):
    global _default_application
    if _default_application is None:
        _default_application = NadrixApplication(
            os.environ.get("NADRIX_DATABASE", str(ROOT / "data" / "nadrix.sqlite3"))
        )
    return _default_application(environ, start_response)
