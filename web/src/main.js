import { connectFirebase, webPushVapidKey } from "./firebase.js";
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPhoneNumber,
  signInWithPopup,
  signOut,
  RecaptchaVerifier,
  updateProfile,
} from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { deleteObject, getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { httpsCallable } from "firebase/functions";
import { getToken, onMessage } from "firebase/messaging";

const state = {
  firebase: null,
  user: null,
  profile: null,
  services: [],
  orders: [],
  notifications: [],
  ordersAdminMode: null,
  authGeneration: 0,
  profileUnsubscribe: null,
  ordersUnsubscribe: null,
  notificationUnsubscribe: null,
  serviceUnsubscribe: null,
  adminServiceUnsubscribe: null,
  projectUnsubscribe: null,
  projectAdminMode: null,
  userUnsubscribe: null,
  phoneConfirmation: null,
  recaptcha: null,
  selectedRole: "customer",
  installPrompt: null,
};

document.addEventListener("DOMContentLoaded", () => {
  initInteractions();
  connect();
});

async function connect() {
  setConnectionStatus("Connecting to NADRIX Firebase services…");
  try {
    state.firebase = await connectFirebase();
    listenForAuth();
    listenForServices();
    registerPwa();
    setConnectionStatus("Firebase connected. Sign in or create an account to submit a request.");
  } catch (error) {
    setConnectionStatus(error.message);
    console.error("NADRIX initialization failed.", error);
  }
}

function listenForAuth() {
  const { auth } = state.firebase;
  onAuthStateChanged(auth, async (user) => {
    const generation = ++state.authGeneration;
    clearAccountListeners();
    state.orders = [];
    state.notifications = [];
    state.ordersAdminMode = null;
    state.adminSummary = null;
    state.adminServices = null;
    document.querySelector("#orders-list")?.replaceChildren();
    document.querySelector("#notifications-list")?.replaceChildren();
    document.querySelector("#admin-users-list")?.replaceChildren();
    document.querySelector("#admin-projects-list")?.replaceChildren();
    state.user = user;
    state.profile = null;
    renderAccount();
    if (!user) {
      listenForProjects();
      setConnectionStatus("Firebase connected. Sign in or create an account to submit a request.");
      return;
    }

    try {
      await ensureProfile(user, selectedSignupRole(), user.displayName || "");
      if (generation !== state.authGeneration) return;
      const profile = await getDoc(doc(state.firebase.db, "users", user.uid));
      if (generation !== state.authGeneration) return;
      state.profile = profile.exists() ? profile.data() : null;
      renderAccount();
      listenForNotifications(generation);
      state.profileUnsubscribe = onSnapshot(
        doc(state.firebase.db, "users", user.uid),
        (snapshot) => {
          if (generation !== state.authGeneration) return;
          state.profile = snapshot.exists() ? snapshot.data() : null;
          renderAccount();
          if (state.profile?.active === true) {
            listenForNotifications(generation);
          } else {
            state.notificationUnsubscribe?.();
            state.notificationUnsubscribe = null;
            state.notifications = [];
            renderNotifications();
          }
          subscribeToOrders(generation);
          if (state.profile?.active === false) {
            signOut(state.firebase.auth).catch((error) => showError(error));
            setConnectionStatus("This account has been disabled. Contact the administrator.");
          }
        },
        (error) => {
          if (generation === state.authGeneration) showError(error);
        },
      );
      subscribeToOrders(generation);
      setConnectionStatus(`Signed in as ${user.email || user.phoneNumber || user.uid}.`);
    } catch (error) {
      if (generation !== state.authGeneration) return;
      setConnectionStatus(`Your account is signed in, but its profile could not load: ${error.message}`);
      showError(error);
    }
  });
}

function ensureProfile(user, role, displayName) {
  return httpsCallable(state.firebase.functions, "initializeUserProfile")({
    role,
    displayName,
  }).then(async (result) => {
    if (user.emailVerified) {
      await user.getIdToken(true);
      return httpsCallable(state.firebase.functions, "initializeUserProfile")({
        role,
        displayName,
      });
    }
    return result;
  });
}

function selectedSignupRole() {
  const value = document.querySelector("#signup-role")?.value;
  return value === "student" ? "student" : "customer";
}

function clearAccountListeners() {
  [
    "profileUnsubscribe",
    "ordersUnsubscribe",
    "notificationUnsubscribe",
    "userUnsubscribe",
    "adminServiceUnsubscribe",
    "projectUnsubscribe",
  ].forEach((key) => {
    state[key]?.();
    state[key] = null;
  });
  state.projectAdminMode = null;
}

function listenForNotifications(generation) {
  if (state.notificationUnsubscribe || state.profile?.active !== true) return;
  state.notificationUnsubscribe = onSnapshot(
    query(
      collection(state.firebase.db, "users", state.user.uid, "notifications"),
      orderBy("createdAt", "desc"),
      limit(50),
    ),
    (snapshot) => {
      if (generation !== state.authGeneration) return;
      state.notifications = snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
      renderNotifications();
    },
    (error) => {
      if (generation === state.authGeneration) showError(error);
    },
  );
}

function listenForServices() {
  const { db } = state.firebase;
  state.serviceUnsubscribe = onSnapshot(
    query(collection(db, "services"), where("isActive", "==", true), orderBy("sortOrder", "asc")),
    (snapshot) => {
      state.services = snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
      renderServiceOptions();
      renderAdminServices();
      updateServiceSearch();
      if (state.profile?.role === "admin") listenForAdminServices();
    },
    showError,
  );
}

function listenForAdminServices() {
  if (state.adminServiceUnsubscribe) return;
  const generation = state.authGeneration;
  state.adminServiceUnsubscribe = onSnapshot(
    query(collection(state.firebase.db, "services"), orderBy("sortOrder", "asc")),
    (snapshot) => {
      if (generation !== state.authGeneration) return;
      state.adminServices = snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
      renderAdminServices();
    },
    (error) => {
      if (generation === state.authGeneration) showError(error);
    },
  );
}

function listenForProjects() {
  const isAdmin = state.profile?.role === "admin";
  if (state.projectUnsubscribe && state.projectAdminMode === isAdmin) return;
  state.projectUnsubscribe?.();
  state.projectAdminMode = isAdmin;
  const generation = state.authGeneration;
  const projectsQuery = isAdmin
    ? query(collection(state.firebase.db, "projects"), orderBy("sortOrder", "asc"), limit(100))
    : query(
      collection(state.firebase.db, "projects"),
      where("isPublished", "==", true),
      orderBy("sortOrder", "asc"),
      limit(30),
    );
  state.projectUnsubscribe = onSnapshot(projectsQuery, (snapshot) => {
    if (generation !== state.authGeneration) return;
    const projects = snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
    renderProjects(projects, isAdmin);
    renderPublicProjects(projects.filter((project) => project.isPublished));
  }, (error) => {
    if (generation === state.authGeneration) showError(error);
  });
}

function subscribeToOrders(generation = state.authGeneration) {
  const { db } = state.firebase;
  const isAdmin = state.profile?.role === "admin";
  if (state.ordersUnsubscribe && state.ordersAdminMode === isAdmin) return;
  state.ordersUnsubscribe?.();
  state.ordersAdminMode = isAdmin;
  const ordersQuery = isAdmin
    ? query(collection(db, "orders"), orderBy("createdAt", "desc"), limit(100))
    : query(
      collection(db, "orders"),
      where("userId", "==", state.user.uid),
      orderBy("createdAt", "desc"),
      limit(100),
    );
  state.ordersUnsubscribe = onSnapshot(ordersQuery, (snapshot) => {
    if (generation !== state.authGeneration) return;
    state.orders = snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
    renderOrders();
    renderAdminDashboard();
  }, (error) => {
    if (generation === state.authGeneration) showError(error);
  });
}

function renderServiceOptions() {
  const select = document.querySelector("#order-service");
  if (!select) return;
  const selected = select.value;
  select.replaceChildren();
  state.services.forEach((service) => {
    const option = document.createElement("option");
    option.value = service.id;
    option.textContent = service.name;
    select.append(option);
  });
  if (state.services.some((service) => service.id === selected)) select.value = selected;
}

function renderAccount() {
  const accountContent = document.querySelector("#account-content");
  const adminPanel = document.querySelector("#admin-management");
  const summary = document.querySelector("#admin-summary");
  accountContent.hidden = !state.user;
  adminPanel.hidden = state.profile?.role !== "admin";
  summary.hidden = state.profile?.role !== "admin";
  if (!state.user) {
    document.querySelector("#orders-list")?.replaceChildren();
    return;
  }

  const name = state.profile?.displayName || state.user.displayName || state.user.email || state.user.phoneNumber || "NADRIX user";
  document.querySelector("#account-greeting").textContent = `${name} · ${state.profile?.role || "account"}`;
  document.querySelector("#profile-name").value = state.profile?.displayName || state.user.displayName || "";
  document.querySelector("#profile-phone").value = state.user.phoneNumber || state.profile?.phoneNumber || "";
  document.querySelector("#account-orders h3").textContent = state.profile?.role === "admin"
    ? "All service requests"
    : "Your service requests";

  const verifyEmail = document.querySelector("#verify-email-button");
  verifyEmail.hidden = !state.user.email || state.user.emailVerified;
  document.querySelector("#claim-admin-button").hidden =
    state.profile?.role === "admin" || !state.user.emailVerified;
  if (state.profile?.role === "admin") {
    loadAdminSummary();
    listenForAdminUsers();
    listenForProjects();
    listenForAdminServices();
  } else {
    state.userUnsubscribe?.();
    state.userUnsubscribe = null;
    state.adminServiceUnsubscribe?.();
    state.adminServiceUnsubscribe = null;
    if (state.projectAdminMode === true) {
      state.projectUnsubscribe?.();
      state.projectUnsubscribe = null;
      state.projectAdminMode = null;
    }
    state.adminServices = null;
    listenForProjects();
  }
}

function renderOrders() {
  const list = document.querySelector("#orders-list");
  if (!list) return;
  list.replaceChildren();
  if (!state.orders.length) {
    appendText(list, "p", "No service requests yet.", "connection-status");
    return;
  }

  state.orders.forEach((order) => {
    const card = document.createElement("article");
    card.className = "order-card";
    const header = document.createElement("div");
    header.className = "order-card-header";
    appendText(header, "span", `${order.serviceName || "Service"} · #${order.id}`);
    appendText(header, "span", formatStatus(order.status));
    card.append(header);
    if (state.profile?.role === "admin" && order.requesterEmail) {
      appendText(card, "p", `Customer: ${order.requesterEmail}`);
    }
    appendText(card, "p", order.details || "");
    appendText(card, "time", formatDate(order.createdAt));

    if (state.profile?.role === "admin") {
      const select = document.createElement("select");
      select.className = "order-status-select";
      select.setAttribute("aria-label", `Update request ${order.id} status`);
      ["new", "in_progress", "completed", "cancelled"].forEach((status) => {
        const option = document.createElement("option");
        option.value = status;
        option.textContent = formatStatus(status);
        option.selected = status === order.status;
        select.append(option);
      });
      select.addEventListener("change", () => updateOrderStatus(order.id, select.value, select));
      card.append(select);
    }
    list.append(card);
  });
}

function renderNotifications() {
  const list = document.querySelector("#notifications-list");
  if (!list) return;
  list.replaceChildren();
  if (!state.notifications.length) {
    appendText(list, "p", "No notifications yet.", "connection-status");
    return;
  }

  state.notifications.forEach((notification) => {
    const card = document.createElement("article");
    card.className = "order-card";
    const serviceName = notification.serviceName || "Service request";
    appendText(
      card,
      "h4",
      notification.type === "order_status" ? `${serviceName} status updated` : "NADRIX account update",
    );
    if (notification.status) {
      appendText(card, "p", `Request #${notification.orderId || ""} · ${formatStatus(notification.status)}`);
    } else if (notification.orderId) {
      appendText(card, "p", `Request #${notification.orderId}`);
    }
    if (notification.createdAt) appendText(card, "time", formatDate(notification.createdAt));
    if (!notification.readAt) {
      const markRead = document.createElement("button");
      markRead.type = "button";
      markRead.className = "link-button";
      markRead.textContent = "Mark as read";
      markRead.addEventListener("click", async () => {
        markRead.disabled = true;
        try {
          await updateDoc(
            doc(state.firebase.db, "users", state.user.uid, "notifications", notification.id),
            { readAt: serverTimestamp() },
          );
        } catch (error) {
          showError(error);
        } finally {
          markRead.disabled = false;
        }
      });
      card.append(markRead);
    }
    list.append(card);
  });
}

function renderAdminDashboard() {
  const dashboard = document.querySelector(".admin-dash");
  if (!dashboard || state.profile?.role !== "admin") return;
  const statusCounts = ["new", "in_progress", "completed", "cancelled"].map((status) =>
    state.orders.filter((order) => order.status === status).length,
  );
  const chart = dashboard.querySelector(".chart-bars");
  chart.replaceChildren();
  statusCounts.forEach((count, index) => {
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.title = `${["New", "In progress", "Completed", "Cancelled"][index]}: ${count}`;
    bar.style.height = `${Math.max(4, Math.min(100, count * 12))}%`;
    chart.append(bar);
  });
  const labels = dashboard.querySelectorAll(".chart-section h4");
  if (labels.length) labels[0].textContent = "Requests by status";
  const values = dashboard.querySelectorAll(".stat-card .value");
  const summary = state.adminSummary;
  if (summary && values.length >= 4) {
    values[0].textContent = Number(summary.users).toLocaleString();
    values[1].textContent = Number(summary.orders).toLocaleString();
    values[2].textContent = Number(summary.services).toLocaleString();
    values[3].textContent = Number(summary.newOrders).toLocaleString();
  }
}

async function loadAdminSummary() {
  if (!state.firebase || state.profile?.role !== "admin") return;
  try {
    const result = await httpsCallable(state.firebase.functions, "getAdminSummary")();
    state.adminSummary = result.data;
    const summary = document.querySelector("#admin-summary");
    summary.replaceChildren();
    [
      ["Users", result.data.users],
      ["Requests", result.data.orders],
      ["Services", result.data.services],
      ["New requests", result.data.newOrders],
    ].forEach(([label, count]) => {
      appendText(summary, "span", `${label}: ${Number(count).toLocaleString()}`);
    });
    renderAdminDashboard();
  } catch (error) {
    showError(error);
  }
}

function listenForAdminUsers() {
  if (state.userUnsubscribe) return;
  const generation = state.authGeneration;
  state.userUnsubscribe = onSnapshot(
    query(collection(state.firebase.db, "users"), orderBy("createdAt", "desc"), limit(100)),
    (snapshot) => {
      if (generation !== state.authGeneration) return;
      renderAdminUsers(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() })));
    },
    (error) => {
      if (generation === state.authGeneration) showError(error);
    },
  );
}

function renderAdminUsers(users) {
  const list = document.querySelector("#admin-users-list");
  list.replaceChildren();
  users.forEach((user) => {
    const card = document.createElement("article");
    card.className = "order-card";
    const email = user.email || user.phoneNumber || user.id;
    appendText(card, "p", `${user.displayName || "NADRIX user"} · ${email}`);
    appendText(card, "p", `Role: ${user.role} · ${user.active ? "Active" : "Disabled"}`);

    if (user.id !== state.user.uid) {
      const role = document.createElement("select");
      role.className = "order-status-select";
      role.setAttribute("aria-label", `Set account role for ${email}`);
      ["customer", "student", "admin"].forEach((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        option.selected = value === user.role;
        role.append(option);
      });
      role.addEventListener("change", () => updateUserRole(user.id, role.value, role));
      card.append(role);

      const active = document.createElement("button");
      active.type = "button";
      active.className = "link-button";
      active.textContent = user.active ? "Disable account" : "Enable account";
      active.addEventListener("click", () => updateUserActive(user.id, !user.active));
      card.append(active);
    }
    list.append(card);
  });
}

function renderAdminServices() {
  const list = document.querySelector("#admin-services-list");
  if (!list) return;
  const services = state.adminServices || state.services;
  list.replaceChildren();
  services.forEach((service) => {
    const card = document.createElement("article");
    card.className = "order-card";
    appendText(card, "p", service.name);
    appendText(card, "p", `${service.description} · ${service.isActive ? "Visible" : "Hidden"}`);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "link-button";
    toggle.textContent = service.isActive ? "Hide service" : "Publish service";
    toggle.addEventListener("click", () => saveService(service.id, { isActive: !service.isActive }));
    card.append(toggle);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "link-button danger-button";
    remove.textContent = "Delete service";
    remove.addEventListener("click", () => removeService(service.id));
    card.append(remove);
    list.append(card);
  });
}

function renderProjects(projects, isAdmin) {
  const list = document.querySelector("#admin-projects-list");
  if (!list) return;
  list.replaceChildren();
  projects.forEach((project) => {
    const card = document.createElement("article");
    card.className = "order-card";
    appendText(card, "p", `${project.title} · ${project.isPublished ? "Published" : "Draft"}`);
    appendText(card, "p", project.description);
    if (isAdmin) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "link-button";
      toggle.textContent = project.isPublished ? "Unpublish" : "Publish";
      toggle.addEventListener("click", () => updateDoc(
        doc(state.firebase.db, "projects", project.id),
        { isPublished: !project.isPublished, updatedAt: serverTimestamp() },
      ).catch(showError));
      card.append(toggle);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "link-button danger-button";
      remove.textContent = "Delete project";
      remove.addEventListener("click", () => deleteDoc(
        doc(state.firebase.db, "projects", project.id),
      ).catch(showError));
      card.append(remove);
    }
    list.append(card);
  });
}

function renderPublicProjects(projects) {
  const list = document.querySelector("#public-projects-list");
  if (!list) return;
  list.replaceChildren();
  if (!projects.length) {
    appendText(list, "p", "Project examples will appear here when published.", "connection-status");
    return;
  }
  projects.forEach((project) => {
    const card = document.createElement("article");
    card.className = "public-project-card";
    appendText(card, "h3", project.title);
    appendText(card, "p", project.description);
    list.append(card);
  });
}

function initInteractions() {
  initAuthForm();
  initPhoneAuth();
  initAccountActions();
  initOrderForm();
  initAdminForms();
  initRoleSelection();
  initSearch();
  initNavigation();
  initInstallPrompt();
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener("click", (event) => {
      const target = document.querySelector(anchor.getAttribute("href"));
      if (target) {
        event.preventDefault();
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });
}

function initAuthForm() {
  const form = document.querySelector(".signin");
  if (!form) return;
  const identity = form.querySelector('[name="identity"]');
  const password = form.querySelector('[name="password"]');
  const email = form.querySelector('[name="email"]');
  const name = form.querySelector('[name="displayName"]');
  const role = form.querySelector('[name="role"]');
  const submit = form.querySelector('[type="submit"]');

  function setMode(mode) {
    const signup = mode === "signup";
    form.dataset.mode = mode;
    form.querySelector(".signin-heading").textContent = signup ? "Create Account" : "Sign In";
    form.querySelector('label[for="signin-identity"]').textContent = "Email";
    form.querySelector(".signup-fields").hidden = !signup;
    email.required = false;
    role.required = signup;
    identity.autocomplete = "email";
    identity.placeholder = "Enter your email address";
    password.autocomplete = signup ? "new-password" : "current-password";
    password.minLength = signup ? 12 : 0;
    form.querySelector(".forgot").hidden = signup;
    submit.textContent = signup ? "Create Account" : "Sign In";
    form.querySelector(".signup-link").firstChild.textContent = signup
      ? "Already have an account? "
      : "Don't have an account? ";
    form.querySelector("#toggle-signup").textContent = signup ? "Sign in" : "Create account";
  }

  form.querySelector("#toggle-signup").addEventListener("click", () => {
    setMode(form.dataset.mode === "signup" ? "login" : "signup");
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.firebase) return showToast("Firebase is not configured. See the connection status above.", "error");
    if (!form.reportValidity()) return;
    submit.disabled = true;
    try {
      if (form.dataset.mode === "signup") {
        state.selectedRole = role.value;
        const result = await createUserWithEmailAndPassword(
          state.firebase.auth,
          identity.value.trim(),
          password.value,
        );
        if (name.value.trim()) await updateProfile(result.user, { displayName: name.value.trim() });
        await ensureProfile(result.user, role.value, name.value.trim());
        await sendEmailVerification(result.user);
        showToast("Account created. Check your email to verify the address.", "success");
      } else {
        await signInWithEmailAndPassword(state.firebase.auth, identity.value.trim(), password.value);
        await state.firebase.auth.currentUser?.getIdToken(true);
        showToast("You are signed in.", "success");
      }
      password.value = "";
      setMode("login");
    } catch (error) {
      showError(error);
    } finally {
      submit.disabled = false;
      submit.textContent = form.dataset.mode === "signup" ? "Create Account" : "Sign In";
    }
  });

  form.querySelector(".social-btn:not(#phone-signin)").addEventListener("click", async () => {
    if (!state.firebase) return showToast("Firebase is not configured.", "error");
    try {
      const result = await signInWithPopup(state.firebase.auth, new GoogleAuthProvider());
      await ensureProfile(result.user, selectedSignupRole(), result.user.displayName || "");
    } catch (error) {
      showError(error);
    }
  });

  form.querySelector(".forgot").addEventListener("click", async () => {
    if (!state.firebase) return showToast("Firebase is not configured.", "error");
    const address = identity.value.trim();
    if (!address) {
      identity.focus();
      return showToast("Enter your email address first.", "error");
    }
    try {
      await sendPasswordResetEmail(state.firebase.auth, address);
      showToast("If the account exists, a password reset email has been sent.", "success");
    } catch (error) {
      showError(error);
    }
  });
}

function initPhoneAuth() {
  const dialog = document.querySelector("#phone-dialog");
  const form = document.querySelector("#phone-auth-form");
  const status = document.querySelector("#phone-auth-status");
  if (!dialog || !form) return;
  document.querySelector("#phone-signin").addEventListener("click", () => {
    status.textContent = "";
    dialog.showModal();
  });
  document.querySelector("#cancel-phone-auth").addEventListener("click", () => dialog.close());
  document.querySelector("#send-phone-code").addEventListener("click", async () => {
    if (!state.firebase) return setPhoneStatus("Firebase is not configured.");
    const phone = form.elements.phone.value.trim();
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
      return setPhoneStatus("Enter a valid phone number in international format, such as +15551234567.");
    }
    const button = document.querySelector("#send-phone-code");
    button.disabled = true;
    try {
      state.recaptcha?.clear();
      state.recaptcha = new RecaptchaVerifier(state.firebase.auth, "recaptcha-container", {
        size: "normal",
        "expired-callback": () => setPhoneStatus("Verification expired. Complete the check and request a new code."),
      });
      state.phoneConfirmation = await signInWithPhoneNumber(
        state.firebase.auth,
        phone,
        state.recaptcha,
      );
      setPhoneStatus("Verification code sent. Enter the code from your SMS.");
    } catch (error) {
      setPhoneStatus(authErrorMessage(error));
    } finally {
      button.disabled = false;
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.phoneConfirmation) return setPhoneStatus("Send a verification code first.");
    const code = form.elements.code.value.trim();
    if (!/^\d{6}$/.test(code)) return setPhoneStatus("Enter the six-digit verification code.");
    try {
      const result = await state.phoneConfirmation.confirm(code);
      await ensureProfile(result.user, selectedSignupRole(), "");
      dialog.close();
      showToast("Phone number verified and signed in.", "success");
    } catch (error) {
      setPhoneStatus(authErrorMessage(error));
    }
  });
}

function setPhoneStatus(message) {
  document.querySelector("#phone-auth-status").textContent = message;
}

function initAccountActions() {
  document.querySelector("#logout-button").addEventListener("click", () => {
    if (state.firebase) signOut(state.firebase.auth).catch(showError);
  });

  document.querySelector("#profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.firebase || !state.user) return;
    const button = event.currentTarget.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const displayName = document.querySelector("#profile-name").value.trim();
      const updates = { displayName, updatedAt: serverTimestamp() };
      const file = document.querySelector("#profile-photo").files[0];
      if (file) {
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
          throw new Error("Choose a JPEG, PNG, or WebP profile image smaller than 5 MB.");
        }
        const extension = file.type.split("/")[1];
        const path = `profile-images/${state.user.uid}/${crypto.randomUUID()}.${extension}`;
        const fileRef = ref(state.firebase.storage, path);
        await uploadBytes(fileRef, file, { contentType: file.type });
        updates.photoURL = await getDownloadURL(fileRef);
      }
      await updateDoc(doc(state.firebase.db, "users", state.user.uid), updates);
      if (displayName !== state.user.displayName) await updateProfile(state.user, { displayName });
      document.querySelector("#profile-photo").value = "";
      showToast("Profile saved.", "success");
    } catch (error) {
      showError(error);
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector("#verify-email-button").addEventListener("click", async () => {
    try {
      if (!state.user) throw new Error("Sign in to verify your email address.");
      await sendEmailVerification(state.user);
      showToast("Verification email sent.", "success");
    } catch (error) {
      showError(error);
    }
  });

  document.querySelector("#claim-admin-button").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await httpsCallable(state.firebase.functions, "claimInitialAdmin")();
      await state.user.getIdToken(true);
      showToast("Administrator account configured. Refresh the page to activate permissions.", "success");
      window.location.reload();
    } catch (error) {
      showError(error);
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector("#delete-account-button").addEventListener("click", async (event) => {
    if (!state.user || !window.confirm("Permanently delete your account, service requests, notifications, and uploaded files? This cannot be undone.")) {
      return;
    }
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await httpsCallable(state.firebase.functions, "deleteMyAccount")();
      await signOut(state.firebase.auth);
      showToast("Your account and associated data were deleted.", "success");
    } catch (error) {
      showError(error);
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector("#enable-notifications").addEventListener("click", enableNotifications);
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || !state.user) return;
    try {
      await state.user.reload();
      await state.user.getIdToken(true);
      await ensureProfile(state.user, selectedSignupRole(), state.user.displayName || "");
    } catch (error) {
      showError(error);
    }
  });
}

async function enableNotifications() {
  if (!state.firebase?.messaging) {
    showToast("Push notifications are not supported in this browser.", "error");
    return;
  }
  if (!webPushVapidKey) {
    showToast("Web push is not configured. Add the Firebase Web Push certificate key first.", "error");
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      showToast("Notification permission was not granted.", "info");
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const token = await getToken(state.firebase.messaging, {
      vapidKey: webPushVapidKey,
      serviceWorkerRegistration: registration,
    });
    if (!token) throw new Error("Firebase did not return a web push token.");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const deviceId = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await setDoc(doc(state.firebase.db, "users", state.user.uid, "devices", deviceId), {
      token,
      platform: "web",
      updatedAt: serverTimestamp(),
    });
    showToast("Push notifications enabled.", "success");
  } catch (error) {
    showError(error);
  }
}

function initOrderForm() {
  const dialog = document.querySelector("#order-dialog");
  const form = document.querySelector("#order-form");
  document.querySelectorAll("[data-service-name], .service-item, .popular-card").forEach((button) => {
    button.addEventListener("click", () => {
      const name = button.dataset.serviceName || button.getAttribute("aria-label") || "Business Website";
      if (!state.user) {
        showToast("Sign in before submitting a service request.", "info");
        document.querySelector(".signin")?.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      if (!state.profile) return showToast("Your account profile is still loading.", "error");
      if (state.profile.email && !state.user.emailVerified) {
        return showToast("Verify your email address before submitting a request.", "error");
      }
      const service = state.services.find((item) => item.name.toLowerCase() === name.toLowerCase());
      if (!service) return showToast("That service is unavailable. Refresh and try again.", "error");
      form.elements.service_id.value = service.id;
      form.elements.details.value = "";
      form.querySelector(".order-status").textContent = "";
      dialog.showModal();
    });
  });
  document.querySelector("#cancel-order").addEventListener("click", () => dialog.close());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    form.querySelector(".order-status").textContent = "Sending your request…";
    try {
      const result = await httpsCallable(state.firebase.functions, "createServiceRequest")({
        serviceId: form.elements.service_id.value,
        details: form.elements.details.value,
      });
      dialog.close();
      showToast(`Request #${result.data.orderId} submitted.`, "success");
    } catch (error) {
      form.querySelector(".order-status").textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
}

async function updateOrderStatus(orderId, status, select) {
  select.disabled = true;
  try {
    await httpsCallable(state.firebase.functions, "updateServiceRequest")({ orderId, status });
    showToast(`Request #${orderId} updated.`, "success");
  } catch (error) {
    showError(error);
  } finally {
    select.disabled = false;
  }
}

function initAdminForms() {
  document.querySelector("#service-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value.trim();
    const description = form.elements.description.value.trim();
    if (name.length < 2 || !description || name.length > 80 || description.length > 500) {
      return showToast("Service name and description are required and must fit the limits.", "error");
    }
    try {
      await addDoc(collection(state.firebase.db, "services"), {
        name,
        description,
        isActive: true,
        sortOrder: state.services.length,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      form.reset();
      showToast("Service added.", "success");
      loadAdminSummary();
    } catch (error) {
      showError(error);
    }
  });

  document.querySelector("#project-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const title = form.elements.title.value.trim();
    const description = form.elements.description.value.trim();
    if (!title || !description || title.length > 100 || description.length > 2000) {
      return showToast("Project title and description are required.", "error");
    }
    try {
      await addDoc(collection(state.firebase.db, "projects"), {
        title,
        description,
        isPublished: true,
        sortOrder: document.querySelectorAll("#admin-projects-list .order-card").length,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      form.reset();
      showToast("Project published.", "success");
    } catch (error) {
      showError(error);
    }
  });
}

async function saveService(serviceId, updates) {
  try {
    await updateDoc(doc(state.firebase.db, "services", serviceId), {
      ...updates,
      updatedAt: serverTimestamp(),
    });
    showToast("Service updated.", "success");
    loadAdminSummary();
  } catch (error) {
    showError(error);
  }
}

async function removeService(serviceId) {
  if (!window.confirm("Delete this service from the catalog? Existing requests will remain in order history.")) return;
  try {
    await deleteDoc(doc(state.firebase.db, "services", serviceId));
    showToast("Service deleted.", "success");
    loadAdminSummary();
  } catch (error) {
    showError(error);
  }
}

async function updateUserRole(uid, role, select) {
  select.disabled = true;
  try {
    await httpsCallable(state.firebase.functions, "setUserRole")({ uid, role });
    showToast("User role updated. They must refresh their session for access changes.", "success");
  } catch (error) {
    showError(error);
  } finally {
    select.disabled = false;
  }
}

async function updateUserActive(uid, active) {
  try {
    await httpsCallable(state.firebase.functions, "setUserActive")({ uid, active });
    showToast(`Account ${active ? "enabled" : "disabled"}.`, "success");
  } catch (error) {
    showError(error);
  }
}

function initRoleSelection() {
  const cards = [...document.querySelectorAll(".role-card")];
  cards.forEach((card) => {
    const choose = () => {
      cards.forEach((item) => {
        item.classList.toggle("active", item === card);
        item.setAttribute("aria-pressed", String(item === card));
      });
      state.selectedRole = card.querySelector("h3").textContent.toLowerCase().includes("student")
        ? "student"
        : "customer";
      document.querySelector("#signup-role").value = state.selectedRole;
    };
    card.addEventListener("click", choose);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        choose();
      }
    });
  });

  document.querySelector(".role-select > .btn-primary")?.addEventListener("click", () => {
    if (document.querySelector(".role-card.active h3")?.textContent.includes("Admin")) {
      setAuthMode("login");
    } else {
      setAuthMode("signup");
    }
    document.querySelector(".signin").scrollIntoView({ behavior: "smooth", block: "center" });
  });
  document.querySelector(".onboarding .btn-primary")?.addEventListener("click", () => {
    setAuthMode("signup");
    document.querySelector(".signin").scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

function setAuthMode(mode) {
  const form = document.querySelector(".signin");
  if (form && form.dataset.mode !== mode) form.querySelector("#toggle-signup").click();
}

function initSearch() {
  document.querySelector("#service-search")?.addEventListener("input", updateServiceSearch);
}

function updateServiceSearch() {
  const input = document.querySelector("#service-search");
  const status = document.querySelector(".search-status");
  if (!input || !status) return;
  const text = input.value.trim().toLocaleLowerCase();
  const cards = [...document.querySelectorAll(".service-item")];
  let visible = 0;
  cards.forEach((card) => {
    card.hidden = !card.textContent.toLocaleLowerCase().includes(text);
    if (!card.hidden) visible += 1;
  });
  status.textContent = text
    ? visible ? `${visible} ${visible === 1 ? "service" : "services"} found.` : "No services match your search."
    : "";
}

function initNavigation() {
  document.querySelectorAll(".bottom-nav .nav-item, .admin-nav .nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      const icon = button.querySelector(".nav-icon")?.textContent || "";
      const label = button.textContent.replace(icon, "").trim();
      const target = label === "Orders" || label === "Dashboard"
        ? "#account-panel"
        : label === "Home"
          ? ".customer-home"
        : label === "Users"
          ? "#admin-users-list"
          : label === "Projects"
            ? "#admin-projects-list"
            : label === "Services"
              ? "#services-title"
              : label === "Profile"
                ? "#profile-form"
                : label === "Notifications"
                  ? "#notifications-panel"
                  : label === "Support"
                    ? "#services-title"
                : null;
      if (
        !state.user
        && ["Orders", "Dashboard", "Users", "Projects", "Profile", "Notifications"].includes(label)
      ) {
        document.querySelector(".signin")?.scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (target) {
        document.querySelector(target)?.scrollIntoView({ behavior: "smooth", block: "center" });
        if (label === "Services") document.querySelector("#service-search")?.focus();
      }
      const nav = button.closest(".bottom-nav, .admin-nav");
      nav.querySelectorAll(".nav-item").forEach((item) => {
        item.classList.toggle("active", item === button);
        item.setAttribute("aria-pressed", String(item === button));
      });
    });
  });

  document.querySelectorAll(".quick-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const text = button.textContent.toLowerCase();
      const target = text.includes("project")
        ? "#project-form"
        : text.includes("service")
          ? "#service-form"
          : "#admin-users-list";
      document.querySelector("#account-panel")?.scrollIntoView({ behavior: "smooth" });
      document.querySelector(target)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });

  document.querySelector(".menu-btn")?.addEventListener("click", () => {
    document.querySelector("#admin-management")?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  document.querySelectorAll(".icon-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const target = !state.user
        ? ".signin"
        : button.getAttribute("aria-label") === "Notifications"
          ? "#notifications-panel"
          : "#profile-form";
      document.querySelector(target)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
  document.querySelectorAll(".section-title .link-button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelector("#service-search")?.focus();
      document.querySelector(".customer-home")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

function initInstallPrompt() {
  const button = document.querySelector("#install-app");
  if (!button) return;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    button.hidden = false;
  });
  button.addEventListener("click", async () => {
    if (!state.installPrompt) return;
    try {
      await state.installPrompt.prompt();
      const choice = await state.installPrompt.userChoice;
      if (choice.outcome === "accepted") showToast("NADRIX is being installed.", "success");
    } catch (error) {
      showError(error);
    } finally {
      state.installPrompt = null;
      button.hidden = true;
    }
  });
}

function registerPwa() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/service-worker.js").catch((error) => {
    console.error("Service worker registration failed.", error);
    setConnectionStatus(`Firebase is connected, but offline support could not start: ${error.message}`);
  });
  if (state.firebase.messaging) {
    onMessage(state.firebase.messaging, (message) => {
      showToast(message.notification?.body || "Your NADRIX account has an update.", "info");
    });
  }
}

function formatStatus(status) {
  return String(status || "unknown").replaceAll("_", " ");
}

function formatDate(timestamp) {
  if (!timestamp?.toDate) return "Date unavailable";
  return timestamp.toDate().toLocaleString();
}

function appendText(parent, tag, text, className = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = String(text);
  parent.append(element);
  return element;
}

function setConnectionStatus(message) {
  const status = document.querySelector("#connection-status");
  if (status) status.textContent = message;
}

function authErrorMessage(error) {
  const messages = {
    "auth/email-already-in-use": "That email already has an account. Sign in or reset its password.",
    "auth/invalid-credential": "The email or password is incorrect.",
    "auth/invalid-email": "Enter a valid email address.",
    "auth/too-many-requests": "Too many attempts. Wait a little and try again.",
    "auth/weak-password": "Choose a stronger password with at least 12 characters.",
    "auth/user-disabled": "This account has been disabled. Contact the administrator.",
    "auth/user-not-found": "No account was found for that email address.",
    "auth/wrong-password": "The email or password is incorrect.",
    "auth/invalid-phone-number": "Enter a valid phone number in international format.",
    "auth/operation-not-allowed": "This sign-in method has not been enabled in Firebase Authentication.",
    "auth/captcha-check-failed": "Phone verification failed. Complete the security check and try again.",
    "auth/quota-exceeded": "Phone verification quota was reached. Try again later.",
  };
  return messages[error?.code] || error?.message || "The authentication request failed.";
}

function showError(error) {
  console.error("NADRIX request failed.", error);
  showToast(authErrorMessage(error), "error");
}

function showToast(message, type = "info") {
  document.querySelector(".nadrix-toast")?.remove();
  const toast = document.createElement("div");
  toast.className = `nadrix-toast ${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
  toast.textContent = message;
  Object.assign(toast.style, {
    position: "fixed",
    bottom: "24px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: "99999",
    maxWidth: "min(90vw, 560px)",
    padding: "12px 18px",
    borderRadius: "12px",
    background: type === "error" ? "#a52b2b" : "#0f2a30",
    color: "#fff",
    border: "1px solid rgba(23,212,196,.45)",
    font: "600 13px Inter, sans-serif",
    boxShadow: "0 8px 30px rgba(0,0,0,.4)",
  });
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), 5000);
}
