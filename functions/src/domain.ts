export type AccountRole = "customer" | "student" | "admin";

export interface ServiceRequestInput {
  serviceId: string;
  details: string;
}

export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainValidationError";
  }
}

export function isAccountRole(value: unknown): value is AccountRole {
  return value === "customer" || value === "student" || value === "admin";
}

export function hasVerifiedContact(emailVerified: unknown, phoneNumber: unknown): boolean {
  return emailVerified === true
    || (typeof phoneNumber === "string" && phoneNumber.length > 0);
}

export function validateNewProfileRole(value: unknown): value is "customer" | "student" {
  return value === "customer" || value === "student";
}

export function validateServiceRequest(input: unknown): ServiceRequestInput {
  if (typeof input !== "object" || input === null) {
    throw new DomainValidationError("A service and project description are required.");
  }
  const data = input as Record<string, unknown>;
  if (
    typeof data.serviceId !== "string"
    || !/^[a-z0-9-]{2,64}$/.test(data.serviceId)
    || typeof data.details !== "string"
  ) {
    throw new DomainValidationError("Choose a valid service and describe your request.");
  }

  const details = data.details.trim();
  if (details.length < 10 || details.length > 2000) {
    throw new DomainValidationError("Describe your request in 10–2000 characters.");
  }
  return { serviceId: data.serviceId, details };
}

export function validateServiceStatus(value: unknown): value is "new" | "in_progress" | "completed" | "cancelled" {
  return value === "new"
    || value === "in_progress"
    || value === "completed"
    || value === "cancelled";
}

export function validateOrderId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
