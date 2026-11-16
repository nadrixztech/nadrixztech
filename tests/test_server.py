import io
import json
import tempfile
import unittest
from http.cookies import SimpleCookie
from pathlib import Path

from server import NadrixApplication


class ApplicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        database_path = Path(self.temporary_directory.name) / "nadrix.sqlite3"
        self.app = NadrixApplication(database_path)

    def tearDown(self):
        self.temporary_directory.cleanup()

    def request(self, path, method="GET", payload=None, cookie=None, csrf=None, scheme="http"):
        body = b"" if payload is None else json.dumps(payload).encode("utf-8")
        environ = {
            "REQUEST_METHOD": method,
            "PATH_INFO": path,
            "CONTENT_LENGTH": str(len(body)),
            "CONTENT_TYPE": "application/json",
            "REMOTE_ADDR": "127.0.0.1",
            "SERVER_NAME": "localhost",
            "SERVER_PORT": "8000",
            "wsgi.url_scheme": scheme,
            "wsgi.input": io.BytesIO(body),
        }
        if cookie:
            environ["HTTP_COOKIE"] = cookie
        if csrf:
            environ["HTTP_X_CSRF_TOKEN"] = csrf
        response = {}

        def start_response(status, headers):
            response["status"] = int(status.split(" ", 1)[0])
            response["headers"] = dict(headers)

        result = b"".join(self.app(environ, start_response))
        content_type = response["headers"].get("Content-Type", "")
        response["body"] = (
            json.loads(result)
            if result and content_type.startswith("application/json")
            else result.decode("utf-8") if result else None
        )
        return response

    @staticmethod
    def session_cookie(response):
        cookies = SimpleCookie()
        cookies.load(response["headers"]["Set-Cookie"])
        return f"nadrix_session={cookies['nadrix_session'].value}"

    def create_customer(self, username="testuser"):
        response = self.request(
            "/api/auth/signup",
            "POST",
            {
                "username": username,
                "email": f"{username}@example.com",
                "password": "correct horse battery",
                "role": "customer",
            },
        )
        self.assertEqual(response["status"], 201)
        return response

    def test_root_serves_website_and_manifest(self):
        root = self.request("/")
        manifest = self.request("/manifest.webmanifest")
        self.assertEqual(root["status"], 200)
        self.assertIn("NADRIX ZTECHNOLOGY", root["body"] if isinstance(root["body"], str) else "")
        self.assertEqual(manifest["status"], 200)

    def test_signup_order_listing_logout_and_csrf(self):
        signup = self.create_customer()
        cookie = self.session_cookie(signup)
        csrf = signup["body"]["csrf_token"]

        denied = self.request(
            "/api/orders",
            "POST",
            {"service_id": 1, "details": "A business website for my shop."},
            cookie=cookie,
        )
        self.assertEqual(denied["status"], 403)

        created = self.request(
            "/api/orders",
            "POST",
            {"service_id": 1, "details": "A business website for my shop."},
            cookie=cookie,
            csrf=csrf,
        )
        self.assertEqual(created["status"], 201)
        orders = self.request("/api/orders", cookie=cookie)
        self.assertEqual(len(orders["body"]["orders"]), 1)
        self.assertEqual(orders["body"]["orders"][0]["service"], "Business Website")

        logged_out = self.request("/api/auth/logout", "POST", cookie=cookie, csrf=csrf)
        self.assertEqual(logged_out["status"], 200)
        self.assertIsNone(self.request("/api/session")["body"]["user"])
        self.assertEqual(self.request("/api/orders")["status"], 401)

    def test_registration_rejects_admin_and_duplicate_accounts(self):
        signup = self.create_customer()
        duplicate = self.request(
            "/api/auth/signup",
            "POST",
            {
                "username": "testuser",
                "email": "other@example.com",
                "password": "correct horse battery",
                "role": "student",
            },
        )
        admin = self.request(
            "/api/auth/signup",
            "POST",
            {
                "username": "notadmin",
                "email": "notadmin@example.com",
                "password": "correct horse battery",
                "role": "admin",
            },
        )
        self.assertEqual(signup["status"], 201)
        self.assertEqual(duplicate["status"], 409)
        self.assertEqual(admin["status"], 400)

    def test_admin_can_view_summary_and_update_order(self):
        customer = self.create_customer()
        customer_cookie = self.session_cookie(customer)
        self.request(
            "/api/orders",
            "POST",
            {"service_id": 2, "details": "Help me plan my final year project."},
            cookie=customer_cookie,
            csrf=customer["body"]["csrf_token"],
        )
        self.app.create_admin("siteadmin", "admin@example.com", "admin password secure")
        denied = self.request("/api/admin/summary", cookie=customer_cookie)
        self.assertEqual(denied["status"], 403)

        login = self.request(
            "/api/auth/login",
            "POST",
            {"identity": "admin@example.com", "password": "admin password secure"},
        )
        admin_cookie = self.session_cookie(login)
        summary = self.request("/api/admin/summary", cookie=admin_cookie)
        self.assertEqual(summary["status"], 200)
        self.assertEqual(summary["body"]["summary"]["orders"], 1)
        changed = self.request(
            "/api/admin/orders/1",
            "PATCH",
            {"status": "in_progress"},
            cookie=admin_cookie,
            csrf=login["body"]["csrf_token"],
        )
        self.assertEqual(changed["status"], 200)
        self.assertEqual(changed["body"]["order"]["status"], "in_progress")

    def test_login_errors_and_secure_cookie(self):
        self.create_customer("secureuser")
        bad_login = self.request(
            "/api/auth/login",
            "POST",
            {"identity": "secureuser", "password": "wrong password"},
        )
        self.assertEqual(bad_login["status"], 401)

        login = self.request(
            "/api/auth/login",
            "POST",
            {"identity": "secureuser", "password": "correct horse battery"},
            scheme="https",
        )
        self.assertEqual(login["status"], 200)
        self.assertIn("; Secure", login["headers"]["Set-Cookie"])
        self.assertIn("HttpOnly", login["headers"]["Set-Cookie"])
        self.assertEqual(login["headers"]["X-Frame-Options"], "DENY")

    def test_static_paths_do_not_escape_project(self):
        self.assertEqual(self.request("/../../etc/passwd")["status"], 404)
        self.assertEqual(self.request("/.git/config")["status"], 404)
        self.assertEqual(self.request("/api/not-real")["status"], 404)

    def test_invalid_json_field_types_return_client_errors(self):
        registration = self.request(
            "/api/auth/signup",
            "POST",
            {
                "username": "badrole",
                "email": "badrole@example.com",
                "password": "correct horse battery",
                "role": [],
            },
        )
        self.assertEqual(registration["status"], 400)
        invalid_unicode = self.request(
            "/api/auth/signup",
            "POST",
            {
                "username": "unicodeuser",
                "email": "unicode@example.com",
                "password": "valid but invalid unicode \ud800",
                "role": "customer",
            },
        )
        self.assertEqual(invalid_unicode["status"], 400)

        customer = self.create_customer("typeduser")
        cookie = self.session_cookie(customer)
        invalid_service = self.request(
            "/api/orders",
            "POST",
            {"service_id": 1.5, "details": "A valid length request description."},
            cookie=cookie,
            csrf=customer["body"]["csrf_token"],
        )
        self.assertEqual(invalid_service["status"], 400)
        oversized_service_id = self.request(
            "/api/orders",
            "POST",
            {"service_id": 9_223_372_036_854_775_808, "details": "A valid length request description."},
            cookie=cookie,
            csrf=customer["body"]["csrf_token"],
        )
        self.assertEqual(oversized_service_id["status"], 400)

        self.app.create_admin("typedadmin", "typedadmin@example.com", "admin password secure")
        login = self.request(
            "/api/auth/login",
            "POST",
            {"identity": "typedadmin", "password": "admin password secure"},
        )
        invalid_status = self.request(
            "/api/admin/orders/1",
            "PATCH",
            {"status": []},
            cookie=self.session_cookie(login),
            csrf=login["body"]["csrf_token"],
        )
        self.assertEqual(invalid_status["status"], 400)
        oversized_order_id = self.request(
            "/api/admin/orders/9223372036854775808",
            "PATCH",
            {},
            cookie=self.session_cookie(login),
            csrf=login["body"]["csrf_token"],
        )
        self.assertEqual(oversized_order_id["status"], 400)


if __name__ == "__main__":
    unittest.main()
