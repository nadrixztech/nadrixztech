import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { ref, uploadBytes } from "firebase/storage";

const projectId = "demo-nadrix";
let environment;

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: await readFile(new URL("../firestore.rules", import.meta.url), "utf8") },
    storage: { rules: await readFile(new URL("../storage.rules", import.meta.url), "utf8") },
  });
});

after(async () => {
  await environment.cleanup();
});

beforeEach(async () => {
  await environment.clearFirestore();
  await environment.clearStorage();
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await Promise.all([
      setDoc(doc(db, "users/customer-1"), { uid: "customer-1", role: "customer", active: true }),
      setDoc(doc(db, "users/customer-2"), { uid: "customer-2", role: "student", active: true }),
      setDoc(doc(db, "users/admin-1"), { uid: "admin-1", role: "admin", active: true }),
      setDoc(doc(db, "users/stale-admin"), { uid: "stale-admin", role: "customer", active: true }),
      setDoc(doc(db, "services/active-service"), {
        name: "Website",
        description: "Active service",
        isActive: true,
        sortOrder: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      setDoc(doc(db, "services/hidden-service"), {
        name: "Hidden",
        description: "Inactive service",
        isActive: false,
        sortOrder: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      setDoc(doc(db, "projects/published-project"), {
        title: "Published project",
        description: "A public example.",
        isPublished: true,
        sortOrder: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      setDoc(doc(db, "projects/draft-project"), {
        title: "Draft project",
        description: "An admin-only example.",
        isPublished: false,
        sortOrder: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      setDoc(doc(db, "orders/customer-order"), {
        userId: "customer-1",
        serviceId: "active-service",
        serviceName: "Website",
        details: "A private customer request",
        status: "new",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      setDoc(doc(db, "orders/other-order"), {
        userId: "customer-2",
        serviceId: "active-service",
        serviceName: "Website",
        details: "Another customer's request",
        status: "new",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      setDoc(doc(db, "users/customer-1/notifications/status-update"), {
        type: "order_status",
        orderId: "customer-order",
        serviceName: "Website",
        status: "completed",
        readAt: null,
        createdAt: new Date(),
      }),
    ]);
  });
});

test("users can edit permitted profile fields but cannot grant themselves privileges", async () => {
  const db = environment.authenticatedContext("customer-1", { role: "customer" }).firestore();
  await assertSucceeds(updateDoc(doc(db, "users/customer-1"), {
    displayName: "Customer One",
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(doc(db, "users/customer-1"), {
    role: "admin",
    updatedAt: serverTimestamp(),
  }));
  await assertFails(deleteDoc(doc(db, "users/customer-1")));
});

test("customers can list only their own queried orders and cannot create orders directly", async () => {
  const db = environment.authenticatedContext("customer-1", { role: "customer" }).firestore();
  const ownOrders = query(
    collection(db, "orders"),
    where("userId", "==", "customer-1"),
    orderBy("createdAt", "desc"),
  );
  const result = await assertSucceeds(getDocs(ownOrders));
  assert.equal(result.size, 1);
  assert.equal((await assertSucceeds(getDoc(doc(db, "orders/customer-order")))).exists(), true);
  await assertFails(getDoc(doc(db, "orders/other-order")));
  await assertFails(setDoc(doc(db, "orders/forged-order"), {
    userId: "customer-1",
    status: "new",
  }));
});

test("clients cannot change request state or ownership; changes go through the trusted function", async () => {
  const adminDb = environment.authenticatedContext("admin-1", { role: "admin" }).firestore();
  await assertFails(updateDoc(doc(adminDb, "orders/customer-order"), {
    status: "in_progress",
    updatedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(doc(adminDb, "orders/customer-order"), {
    userId: "admin-1",
    status: "completed",
    updatedAt: serverTimestamp(),
  }));
  const customerDb = environment.authenticatedContext("customer-1", { role: "customer" }).firestore();
  await assertFails(updateDoc(doc(customerDb, "orders/customer-order"), {
    status: "completed",
    updatedAt: serverTimestamp(),
  }));
});

test("users can read their own notifications and only mark them as read", async () => {
  const ownerDb = environment.authenticatedContext("customer-1", { role: "customer" }).firestore();
  const notification = doc(ownerDb, "users/customer-1/notifications/status-update");
  assert.equal((await assertSucceeds(getDoc(notification))).exists(), true);
  await assertSucceeds(updateDoc(notification, { readAt: serverTimestamp() }));
  await assertFails(updateDoc(notification, {
    status: "cancelled",
    readAt: serverTimestamp(),
  }));
  await assertFails(deleteDoc(notification));

  const otherDb = environment.authenticatedContext("customer-2", { role: "student" }).firestore();
  await assertFails(getDoc(doc(otherDb, "users/customer-1/notifications/status-update")));
});

test("public catalog reads exclude inactive services", async () => {
  const db = environment.unauthenticatedContext().firestore();
  assert.equal((await assertSucceeds(getDoc(doc(db, "services/active-service")))).exists(), true);
  await assertFails(getDoc(doc(db, "services/hidden-service")));
  await assertFails(getDocs(collection(db, "services")));

  const adminDb = environment.authenticatedContext("admin-1", { role: "admin" }).firestore();
  assert.equal((await assertSucceeds(getDoc(doc(adminDb, "services/hidden-service")))).exists(), true);
});

test("public project reads exclude drafts and only admins can create projects", async () => {
  const publicDb = environment.unauthenticatedContext().firestore();
  const published = await assertSucceeds(getDocs(query(
    collection(publicDb, "projects"),
    where("isPublished", "==", true),
    orderBy("sortOrder", "asc"),
  )));
  assert.equal(published.size, 1);
  await assertFails(getDoc(doc(publicDb, "projects/draft-project")));
  await assertFails(setDoc(doc(publicDb, "projects/forged-project"), {
    title: "Forged",
    description: "Not an administrator.",
    isPublished: true,
    sortOrder: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }));
  const adminDb = environment.authenticatedContext("admin-1", { role: "admin" }).firestore();
  assert.equal((await assertSucceeds(getDocs(collection(adminDb, "projects")))).size, 2);

  const staleAdminDb = environment.authenticatedContext("stale-admin", { role: "admin" }).firestore();
  await assertFails(getDoc(doc(staleAdminDb, "projects/draft-project")));
  await assertFails(getDocs(collection(staleAdminDb, "users")));
});

test("storage limits profile images to their owner and image MIME types", async () => {
  const ownerStorage = environment.authenticatedContext("customer-1", { role: "customer" }).storage();
  const image = new Uint8Array([1, 2, 3]);
  await assertSucceeds(uploadBytes(
    ref(ownerStorage, "profile-images/customer-1/avatar.png"),
    image,
    { contentType: "image/png" },
  ));
  await assertFails(uploadBytes(
    ref(ownerStorage, "profile-images/customer-2/avatar.png"),
    image,
    { contentType: "image/png" },
  ));
  await assertFails(uploadBytes(
    ref(ownerStorage, "profile-images/customer-1/payload.html"),
    image,
    { contentType: "text/html" },
  ));
});
