import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { getStorage } from "firebase-admin/storage";
import { defineString } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import {
  DomainValidationError,
  hasVerifiedContact,
  isAccountRole,
  validateOrderId,
  validateServiceRequest,
  validateServiceStatus,
  type ServiceRequestInput,
} from "./domain.js";

initializeApp();

const region = "asia-south1";
const db = getFirestore();
const initialAdminEmail = defineString("INITIAL_ADMIN_EMAIL", {
  default: "",
  description: "Verified email allowed to claim the first NADRIX administrator account",
});

const defaultServices = [
  ["business-website", "Business Website", "Responsive websites for your business."],
  ["college-project", "College Project", "Project support for students."],
  ["custom-development", "Custom Development", "Custom applications, dashboards, and integrations."],
  ["ecommerce", "E-commerce", "Online stores and e-commerce solutions."],
  ["web-app", "Web App", "Interactive web applications."],
  ["it-services", "IT Services", "Hosting, domains, maintenance, and support."],
] as const;

function requireAuth(uid: string | undefined): asserts uid is string {
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in to continue.");
  }
}

async function requireAdmin(uid: string | undefined, tokenRole: unknown): Promise<string> {
  requireAuth(uid);
  const profile = await requireActiveProfile(uid);
  if (tokenRole !== "admin" || profile.role !== "admin") {
    throw new HttpsError("permission-denied", "Administrator access is required.");
  }
  return uid;
}

async function requireActiveProfile(uid: string): Promise<FirebaseFirestore.DocumentData> {
  const snapshot = await db.collection("users").doc(uid).get();
  if (!snapshot.exists || snapshot.get("active") !== true) {
    throw new HttpsError("permission-denied", "This account is not active.");
  }
  return snapshot.data()!;
}

async function assertAnotherActiveAdminExists(
  transaction: FirebaseFirestore.Transaction,
  message: string,
): Promise<void> {
  const activeAdmins = await transaction.get(
    db.collection("users").where("role", "==", "admin").where("active", "==", true),
  );
  if (activeAdmins.size <= 1) {
    throw new HttpsError("failed-precondition", message);
  }
}

async function deleteQueryInBatches(query: FirebaseFirestore.Query): Promise<void> {
  while (true) {
    const snapshot = await query.limit(400).get();
    if (snapshot.empty) return;
    const batch = db.batch();
    snapshot.docs.forEach((document) => batch.delete(document.ref));
    await batch.commit();
  }
}

export const initializeUserProfile = onCall({ region }, async (request) => {
  const auth = request.auth;
  requireAuth(auth?.uid);
  if (!auth) {
    throw new HttpsError("unauthenticated", "Sign in to continue.");
  }
  const role = request.data?.role;
  const displayName = typeof request.data?.displayName === "string"
    ? request.data.displayName.trim().slice(0, 80)
    : "";
  const userRef = db.collection("users").doc(auth.uid);
  if (role !== "customer" && role !== "student") {
    throw new HttpsError("invalid-argument", "Choose a customer or student account.");
  }

  const token = auth.token;
  const resultingRole = await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(userRef);
    if (existing.exists) {
      transaction.update(userRef, {
        email: typeof token.email === "string" ? token.email.toLowerCase() : null,
        emailVerified: token.email_verified === true,
        phoneNumber: typeof token.phone_number === "string" ? token.phone_number : null,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return String(existing.get("role"));
    }
    transaction.create(userRef, {
      uid: auth.uid,
      email: typeof token.email === "string" ? token.email.toLowerCase() : null,
      emailVerified: token.email_verified === true,
      phoneNumber: typeof token.phone_number === "string" ? token.phone_number : null,
      displayName,
      photoURL: typeof token.picture === "string" ? token.picture : null,
      role,
      active: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return role;
  });
  return { uid: auth.uid, role: resultingRole };
});

export const createServiceRequest = onCall({ region }, async (request) => {
  const uid = request.auth?.uid;
  requireAuth(uid);
  let input: ServiceRequestInput;
  try {
    input = validateServiceRequest(request.data);
  } catch (error) {
    if (error instanceof DomainValidationError) {
      throw new HttpsError("invalid-argument", error.message);
    }
    throw error;
  }
  if (!hasVerifiedContact(
    request.auth?.token.email_verified,
    request.auth?.token.phone_number,
  )) {
    throw new HttpsError(
      "failed-precondition",
      "Verify your email address or sign in with a verified phone number before submitting a request.",
    );
  }

  const profileRef = db.collection("users").doc(uid);
  const serviceRef = db.collection("services").doc(input.serviceId);
  const orderRef = db.collection("orders").doc();
  await db.runTransaction(async (transaction) => {
    const [profile, service] = await Promise.all([
      transaction.get(profileRef),
      transaction.get(serviceRef),
    ]);
    if (!profile.exists || profile.get("active") !== true || profile.get("deletionPending") === true) {
      throw new HttpsError("permission-denied", "This account is not active.");
    }
    if (!service.exists || service.get("isActive") !== true) {
      throw new HttpsError("not-found", "That service is not currently available.");
    }
    transaction.create(orderRef, {
      userId: uid,
      requesterEmail: profile.get("email") ?? null,
      serviceId: input.serviceId,
      serviceName: service.get("name"),
      details: input.details,
      status: "new",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  return { orderId: orderRef.id };
});

export const updateServiceRequest = onCall({ region }, async (request) => {
  const actorUid = await requireAdmin(request.auth?.uid, request.auth?.token.role);
  const orderId = request.data?.orderId;
  const status = request.data?.status;
  if (!validateOrderId(orderId) || !validateServiceStatus(status)) {
    throw new HttpsError("invalid-argument", "Choose a valid request and status.");
  }

  const orderRef = db.collection("orders").doc(orderId);
  const previousStatus = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(orderRef);
    if (!snapshot.exists) {
      throw new HttpsError("not-found", "Service request not found.");
    }
    const previous = snapshot.get("status");
    transaction.update(orderRef, {
      status,
      updatedBy: actorUid,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return previous;
  });
  await db.collection("auditLog").add({
    actorUid,
    action: "service_request_status_updated",
    orderId,
    previousStatus,
    status,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { orderId, status };
});

export const claimInitialAdmin = onCall({ region }, async (request) => {
  const auth = request.auth;
  requireAuth(auth?.uid);
  if (!auth) {
    throw new HttpsError("unauthenticated", "Sign in to continue.");
  }
  const email = auth.token.email;
  const expectedEmail = initialAdminEmail.value().trim().toLowerCase();
  if (
    !expectedEmail
    || typeof email !== "string"
    || email.toLowerCase() !== expectedEmail
    || auth.token.email_verified !== true
  ) {
    throw new HttpsError("permission-denied", "Only the configured, verified bootstrap email may claim initial admin.");
  }

  const user = await getAuth().getUser(auth.uid);
  const bootstrapRef = db.doc("internal/adminBootstrap");
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(bootstrapRef);
    if (snapshot.exists && snapshot.get("uid") !== user.uid) {
      throw new HttpsError("failed-precondition", "The initial administrator has already been claimed.");
    }
    if (!snapshot.exists) {
      transaction.create(bootstrapRef, {
        uid: user.uid,
        email: expectedEmail,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  });

  try {
    await getAuth().setCustomUserClaims(user.uid, {
      ...user.customClaims,
      role: "admin",
    });
    await db.collection("users").doc(user.uid).set({
      uid: user.uid,
      email: user.email?.toLowerCase() ?? expectedEmail,
      emailVerified: true,
      displayName: user.displayName ?? "",
      phoneNumber: user.phoneNumber,
      photoURL: user.photoURL,
      role: "admin",
      active: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    const serviceCollection = db.collection("services");
    const existingServices = await serviceCollection.limit(1).get();
    if (existingServices.empty) {
      const batch = db.batch();
      defaultServices.forEach(([id, name, description], sortOrder) => {
        batch.create(serviceCollection.doc(id), {
          name,
          description,
          isActive: true,
          sortOrder,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      await batch.commit();
    }
  } catch (error) {
    console.error("Initial admin setup failed after claiming the bootstrap lock.", error);
    throw new HttpsError("internal", "Administrator setup could not finish. Contact the project owner.");
  }
  return { message: "Initial administrator set. Refresh your ID token to continue." };
});

export const setUserRole = onCall({ region }, async (request) => {
  const actorUid = await requireAdmin(request.auth?.uid, request.auth?.token.role);
  const uid = request.data?.uid;
  const role = request.data?.role;
  if (typeof uid !== "string" || !uid || uid === actorUid) {
    throw new HttpsError("invalid-argument", "Choose a different user to update.");
  }
  if (!isAccountRole(role)) {
    throw new HttpsError("invalid-argument", "Choose a supported account role.");
  }

  const targetAuth = await getAuth().getUser(uid);
  if (role === "admin" && (!targetAuth.email || !targetAuth.emailVerified)) {
    throw new HttpsError("failed-precondition", "An administrator must have a verified email address.");
  }
  const targetRef = db.collection("users").doc(uid);
  const previousRole = await db.runTransaction(async (transaction) => {
    const targetSnapshot = await transaction.get(targetRef);
    if (!targetSnapshot.exists) {
      throw new HttpsError("not-found", "User not found.");
    }
    if (targetSnapshot.get("deletionPending") === true) {
      throw new HttpsError("failed-precondition", "This account is being deleted.");
    }
    const previous = targetSnapshot.get("role");
    if (previous === "admin" && role !== "admin" && targetSnapshot.get("active") === true) {
      await assertAnotherActiveAdminExists(
        transaction,
        "The last active administrator cannot be demoted.",
      );
    }
    transaction.update(targetRef, { role, updatedAt: FieldValue.serverTimestamp() });
    return previous;
  });

  const claims = { ...targetAuth.customClaims };
  if (role === "admin") claims.role = "admin";
  else delete claims.role;
  await getAuth().setCustomUserClaims(uid, {
    ...claims,
  });
  await db.collection("auditLog").add({
    actorUid,
    action: "user_role_updated",
    targetUid: uid,
    previousRole,
    role,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { uid, role };
});

export const setUserActive = onCall({ region }, async (request) => {
  const actorUid = await requireAdmin(request.auth?.uid, request.auth?.token.role);
  const uid = request.data?.uid;
  const active = request.data?.active;
  if (typeof uid !== "string" || !uid || uid === actorUid || typeof active !== "boolean") {
    throw new HttpsError("invalid-argument", "Choose another user and a valid account status.");
  }
  const userRef = db.collection("users").doc(uid);
  await db.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(userRef);
    if (!userSnapshot.exists) {
      throw new HttpsError("not-found", "User not found.");
    }
    if (userSnapshot.get("deletionPending") === true) {
      throw new HttpsError("failed-precondition", "This account is being deleted.");
    }
    if (
      !active
      && userSnapshot.get("active") === true
      && userSnapshot.get("role") === "admin"
    ) {
      await assertAnotherActiveAdminExists(
        transaction,
        "The last active administrator cannot be disabled.",
      );
    }
    transaction.update(userRef, { active, updatedAt: FieldValue.serverTimestamp() });
  });
  await getAuth().updateUser(uid, { disabled: !active });
  await db.collection("auditLog").add({
    actorUid,
    action: active ? "user_enabled" : "user_disabled",
    targetUid: uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { uid, active };
});

export const getAdminSummary = onCall({ region }, async (request) => {
  await requireAdmin(request.auth?.uid, request.auth?.token.role);
  const [users, orders, services, newOrders] = await Promise.all([
    db.collection("users").count().get(),
    db.collection("orders").count().get(),
    db.collection("services").count().get(),
    db.collection("orders").where("status", "==", "new").count().get(),
  ]);
  return {
    users: users.data().count,
    orders: orders.data().count,
    services: services.data().count,
    newOrders: newOrders.data().count,
  };
});

export const deleteMyAccount = onCall({ region, timeoutSeconds: 120 }, async (request) => {
  const uid = request.auth?.uid;
  requireAuth(uid);
  const userRef = db.collection("users").doc(uid);
  await db.runTransaction(async (transaction) => {
    const profile = await transaction.get(userRef);
    if (!profile.exists || profile.get("deletionPending") === true) return;
    if (profile.get("active") !== true) {
      throw new HttpsError("permission-denied", "This account is not active.");
    }
    if (profile.get("role") === "admin") {
      await assertAnotherActiveAdminExists(
        transaction,
        "Assign another active administrator before deleting this account.",
      );
    }
    transaction.update(userRef, {
      active: false,
      deletionPending: true,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  await deleteQueryInBatches(db.collection("orders").where("userId", "==", uid));
  for (const subcollection of ["devices", "notifications"]) {
    await deleteQueryInBatches(userRef.collection(subcollection));
  }
  await Promise.all([
    getStorage().bucket().deleteFiles({ prefix: `profile-images/${uid}/` }),
    getStorage().bucket().deleteFiles({ prefix: `order-files/${uid}/` }),
  ]);
  await userRef.delete();
  await getAuth().deleteUser(uid);
  return { deleted: true };
});

async function sendPushToUsers(
  userIds: string[],
  notification: { title: string; body: string },
  data: Record<string, string>,
): Promise<void> {
  const deviceSnapshots = await Promise.all(
    userIds.map((uid) => db.collection("users").doc(uid).collection("devices").get()),
  );
  const devices = deviceSnapshots.flatMap((snapshot) =>
    snapshot.docs.map((document) => ({ ref: document.ref, token: document.get("token") as string })),
  ).filter((device) => typeof device.token === "string" && device.token.length > 0);

  for (let offset = 0; offset < devices.length; offset += 500) {
    const group = devices.slice(offset, offset + 500);
    const result = await getMessaging().sendEachForMulticast({
      tokens: group.map((device) => device.token),
      notification,
      data,
    });
    const stale = result.responses.flatMap((response, index) => {
      const code = response.error?.code;
      return code === "messaging/registration-token-not-registered"
        || code === "messaging/invalid-registration-token"
        ? [group[index].ref]
        : [];
    });
    for (let index = 0; index < stale.length; index += 400) {
      const batch = db.batch();
      stale.slice(index, index + 400).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }
    if (result.failureCount > stale.length) {
      console.error("Some push notifications failed.", {
        failed: result.failureCount,
        staleTokensRemoved: stale.length,
      });
    }
  }
}

export const notifyAdminsOnNewRequest = onDocumentCreated({
  document: "orders/{orderId}",
  region,
}, async (event) => {
  const order = event.data?.data();
  if (!order) return;
  const admins = await db.collection("users")
    .where("role", "==", "admin")
    .where("active", "==", true)
    .get();
  const adminIds = admins.docs.map((document) => document.id);
  await sendPushToUsers(adminIds, {
    title: "New service request",
    body: `${String(order.serviceName ?? "A service").slice(0, 80)} request received.`,
  }, {
    type: "new_request",
    orderId: event.params.orderId,
  });
});

export const notifyCustomerOnStatusChange = onDocumentUpdated({
  document: "orders/{orderId}",
  region,
}, async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!before || !after || before.status === after.status) return;
  const userId = after.userId;
  if (typeof userId !== "string") {
    console.error("Updated order has no owner.", { orderId: event.params.orderId });
    return;
  }

  await db.collection("users").doc(userId).collection("notifications").add({
    type: "order_status",
    orderId: event.params.orderId,
    serviceName: String(after.serviceName ?? "Service request").slice(0, 80),
    status: String(after.status),
    readAt: null,
    createdAt: FieldValue.serverTimestamp(),
  });
  await sendPushToUsers([userId], {
    title: "Request status updated",
    body: `${String(after.serviceName ?? "Your request").slice(0, 60)} is now ${String(after.status).replace("_", " ")}.`,
  }, {
    type: "order_status",
    orderId: event.params.orderId,
    status: String(after.status),
  });
});
