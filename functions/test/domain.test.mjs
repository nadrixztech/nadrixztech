import assert from "node:assert/strict";
import test from "node:test";
import {
  hasVerifiedContact,
  isAccountRole,
  validateNewProfileRole,
  validateServiceRequest,
  validateServiceStatus,
} from "../lib/domain.js";

test("profile roles allow only customer and student during self-registration", () => {
  assert.equal(validateNewProfileRole("customer"), true);
  assert.equal(validateNewProfileRole("student"), true);
  assert.equal(validateNewProfileRole("admin"), false);
  assert.equal(validateNewProfileRole(null), false);
});

test("administrative role validation recognizes only supported roles", () => {
  for (const role of ["customer", "student", "admin"]) assert.equal(isAccountRole(role), true);
  for (const role of ["owner", "", null, {}]) assert.equal(isAccountRole(role), false);
});

test("service requests require a verified email or verified phone claim", () => {
  assert.equal(hasVerifiedContact(true, undefined), true);
  assert.equal(hasVerifiedContact(false, "+15551234567"), true);
  assert.equal(hasVerifiedContact(false, ""), false);
  assert.equal(hasVerifiedContact(false, undefined), false);
});

test("service request input is trimmed and constrained", () => {
  assert.deepEqual(
    validateServiceRequest({ serviceId: "college-project", details: "  A valid description  " }),
    { serviceId: "college-project", details: "A valid description" },
  );
  for (const input of [
    null,
    {},
    { serviceId: "../orders", details: "A valid description" },
    { serviceId: "business-website", details: "short" },
    { serviceId: "business-website", details: "x".repeat(2001) },
  ]) {
    assert.throws(() => validateServiceRequest(input), { name: "DomainValidationError" });
  }
});

test("order statuses reject arbitrary values", () => {
  for (const status of ["new", "in_progress", "completed", "cancelled"]) {
    assert.equal(validateServiceStatus(status), true);
  }
  assert.equal(validateServiceStatus("deleted"), false);
  assert.equal(validateServiceStatus(null), false);
});
