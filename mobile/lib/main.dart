import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:firebase_storage/firebase_storage.dart';
import 'package:flutter/material.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:image_picker/image_picker.dart';

const _background = Color(0xFF061316);
const _surface = Color(0xFF0F2A30);
const _teal = Color(0xFF17D4C4);
const _region = 'asia-south1';
const _googleServerClientId = String.fromEnvironment('GOOGLE_SERVER_CLIENT_ID');
Future<void>? _googleInitialization;

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    final options = _firebaseOptions();
    await Firebase.initializeApp(options: options);
    runApp(const NadrixApp());
  } catch (error) {
    runApp(SetupRequiredApp(message: error.toString()));
  }
}

FirebaseOptions _firebaseOptions() {
  const apiKey = String.fromEnvironment('FIREBASE_API_KEY');
  const appId = String.fromEnvironment('FIREBASE_APP_ID');
  const senderId = String.fromEnvironment('FIREBASE_MESSAGING_SENDER_ID');
  const projectId = String.fromEnvironment('FIREBASE_PROJECT_ID');
  const storageBucket = String.fromEnvironment('FIREBASE_STORAGE_BUCKET');
  if ([
    apiKey,
    appId,
    senderId,
    projectId,
    storageBucket,
  ].any((value) => value.isEmpty)) {
    throw StateError(
      'Firebase is not configured. See the Firebase setup instructions in README.md.',
    );
  }

  if (Platform.isAndroid) {
    return FirebaseOptions(
      apiKey: apiKey,
      appId: appId,
      messagingSenderId: senderId,
      projectId: projectId,
      storageBucket: storageBucket,
    );
  }
  if (Platform.isIOS) {
    return FirebaseOptions(
      apiKey: apiKey,
      appId: appId,
      messagingSenderId: senderId,
      projectId: projectId,
      storageBucket: storageBucket,
      iosBundleId: 'com.nadrixztechnology.app',
    );
  }
  throw UnsupportedError('NADRIX supports Android and iOS.');
}

class NadrixApp extends StatelessWidget {
  const NadrixApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'NADRIX ZTECHNOLOGY',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      brightness: Brightness.dark,
      scaffoldBackgroundColor: _background,
      colorScheme: ColorScheme.fromSeed(
        seedColor: _teal,
        brightness: Brightness.dark,
        surface: _surface,
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: _background,
        foregroundColor: Colors.white,
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: _surface,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
      ),
      cardTheme: CardThemeData(
        color: _surface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      ),
      useMaterial3: true,
    ),
    home: const AuthGate(),
  );
}

class SetupRequiredApp extends StatelessWidget {
  const SetupRequiredApp({required this.message, super.key});

  final String message;

  @override
  Widget build(BuildContext context) => MaterialApp(
    theme: ThemeData.dark(),
    home: Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.settings_suggest, size: 52, color: _teal),
                const SizedBox(height: 18),
                const Text(
                  'Finish Firebase setup',
                  style: TextStyle(fontSize: 22),
                ),
                const SizedBox(height: 12),
                Text(message, textAlign: TextAlign.center),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}

class AuthGate extends StatelessWidget {
  const AuthGate({super.key});

  @override
  Widget build(BuildContext context) => StreamBuilder<User?>(
    stream: FirebaseAuth.instance.authStateChanges(),
    builder: (context, snapshot) {
      if (snapshot.connectionState == ConnectionState.waiting) {
        return const Scaffold(body: Center(child: CircularProgressIndicator()));
      }
      final user = snapshot.data;
      return user == null ? const AuthScreen() : HomeScreen(user: user);
    },
  );
}

class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key});

  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> {
  final _formKey = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _name = TextEditingController();
  String _role = 'customer';
  bool _registering = false;
  bool _busy = false;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _name.dispose();
    super.dispose();
  }

  void _report(Object error) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(_friendlyError(error))));
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _busy = true);
    try {
      final auth = FirebaseAuth.instance;
      if (_registering) {
        final credential = await auth.createUserWithEmailAndPassword(
          email: _email.text.trim(),
          password: _password.text,
        );
        final displayName = _name.text.trim();
        await credential.user!.updateDisplayName(displayName);
        await credential.user!.sendEmailVerification();
        await FirebaseFunctions.instanceFor(region: _region)
            .httpsCallable('initializeUserProfile')
            .call({'role': _role, 'displayName': displayName});
      } else {
        await auth.signInWithEmailAndPassword(
          email: _email.text.trim(),
          password: _password.text,
        );
      }
    } catch (error) {
      _report(error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _resetPassword() async {
    final email = _email.text.trim();
    if (email.isEmpty) {
      _report(StateError('Enter your email address first.'));
      return;
    }
    try {
      await FirebaseAuth.instance.sendPasswordResetEmail(email: email);
      if (mounted) _report(StateError('Password reset email sent.'));
    } catch (error) {
      _report(error);
    }
  }

  Future<void> _googleSignIn() async {
    setState(() => _busy = true);
    try {
      _googleInitialization ??= GoogleSignIn.instance.initialize(
        serverClientId: _googleServerClientId.isEmpty
            ? null
            : _googleServerClientId,
      );
      await _googleInitialization;
      final account = await GoogleSignIn.instance.authenticate();
      final token = account.authentication.idToken;
      if (token == null) throw StateError('Google did not return an ID token.');
      await FirebaseAuth.instance.signInWithCredential(
        GoogleAuthProvider.credential(idToken: token),
      );
    } catch (error) {
      _report(error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _phoneSignIn() async {
    final phone = await _askForValue(
      context: context,
      title: 'Phone sign in',
      label: 'Phone number with country code',
      hint: '+15551234567',
    );
    if (phone == null || phone.trim().isEmpty) return;
    setState(() => _busy = true);
    final sent = Completer<String>();
    final automatic = Completer<PhoneAuthCredential>();
    try {
      await FirebaseAuth.instance.verifyPhoneNumber(
        phoneNumber: phone.trim(),
        verificationCompleted: (credential) {
          if (!automatic.isCompleted) automatic.complete(credential);
        },
        verificationFailed: (error) {
          if (!sent.isCompleted) sent.completeError(error);
          if (!automatic.isCompleted) automatic.completeError(error);
        },
        codeSent: (verificationId, _) {
          if (!sent.isCompleted) sent.complete(verificationId);
        },
        codeAutoRetrievalTimeout: (verificationId) {
          if (!sent.isCompleted) sent.complete(verificationId);
        },
      );
      final first = await Future.any<Object>([sent.future, automatic.future]);
      if (first is PhoneAuthCredential) {
        await FirebaseAuth.instance.signInWithCredential(first);
      } else {
        if (!mounted) return;
        final code = await _askForValue(
          context: context,
          title: 'Verification code',
          label: 'Six-digit SMS code',
        );
        if (code == null || code.trim().isEmpty) return;
        await FirebaseAuth.instance.signInWithCredential(
          PhoneAuthProvider.credential(
            verificationId: first as String,
            smsCode: code.trim(),
          ),
        );
      }
    } catch (error) {
      _report(error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480),
            child: Form(
              key: _formKey,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Icon(Icons.hub_outlined, color: _teal, size: 54),
                  const SizedBox(height: 12),
                  Text(
                    'NADRIX ZTECHNOLOGY',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 28),
                  SegmentedButton<bool>(
                    segments: const [
                      ButtonSegment(value: false, label: Text('Sign in')),
                      ButtonSegment(value: true, label: Text('Create account')),
                    ],
                    selected: {_registering},
                    onSelectionChanged: _busy
                        ? null
                        : (selection) =>
                              setState(() => _registering = selection.first),
                  ),
                  const SizedBox(height: 18),
                  if (_registering) ...[
                    TextFormField(
                      controller: _name,
                      decoration: const InputDecoration(labelText: 'Full name'),
                      validator: (value) =>
                          value == null || value.trim().isEmpty
                          ? 'Enter your name.'
                          : null,
                    ),
                    const SizedBox(height: 12),
                    DropdownButtonFormField<String>(
                      initialValue: _role,
                      decoration: const InputDecoration(
                        labelText: 'Account type',
                      ),
                      items: const [
                        DropdownMenuItem(
                          value: 'customer',
                          child: Text('Customer'),
                        ),
                        DropdownMenuItem(
                          value: 'student',
                          child: Text('Student'),
                        ),
                      ],
                      onChanged: (value) =>
                          setState(() => _role = value ?? 'customer'),
                    ),
                    const SizedBox(height: 12),
                  ],
                  TextFormField(
                    controller: _email,
                    keyboardType: TextInputType.emailAddress,
                    autofillHints: const [AutofillHints.email],
                    decoration: const InputDecoration(labelText: 'Email'),
                    validator: (value) =>
                        value == null ||
                            !RegExp(
                              r'^[^@\s]+@[^@\s]+\.[^@\s]+$',
                            ).hasMatch(value.trim())
                        ? 'Enter a valid email address.'
                        : null,
                  ),
                  const SizedBox(height: 12),
                  TextFormField(
                    controller: _password,
                    obscureText: true,
                    autofillHints: [
                      _registering
                          ? AutofillHints.newPassword
                          : AutofillHints.password,
                    ],
                    decoration: const InputDecoration(labelText: 'Password'),
                    validator: (value) =>
                        value == null || value.length < (_registering ? 12 : 1)
                        ? _registering
                              ? 'Use at least 12 characters.'
                              : 'Enter your password.'
                        : null,
                  ),
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton(
                      onPressed: _busy ? null : _resetPassword,
                      child: const Text('Forgot password?'),
                    ),
                  ),
                  FilledButton(
                    onPressed: _busy ? null : _submit,
                    child: _busy
                        ? const SizedBox.square(
                            dimension: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : Text(_registering ? 'Create account' : 'Sign in'),
                  ),
                  const SizedBox(height: 8),
                  OutlinedButton.icon(
                    onPressed: _busy ? null : _googleSignIn,
                    icon: const Icon(Icons.account_circle_outlined),
                    label: const Text('Continue with Google'),
                  ),
                  OutlinedButton.icon(
                    onPressed: _busy ? null : _phoneSignIn,
                    icon: const Icon(Icons.phone_android),
                    label: const Text('Continue with phone'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({required this.user, super.key});

  final User user;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late Future<void> _profileReady;
  StreamSubscription<RemoteMessage>? _messageSubscription;
  int _tab = 0;

  FirebaseFirestore get _db => FirebaseFirestore.instance;
  FirebaseFunctions get _functions =>
      FirebaseFunctions.instanceFor(region: _region);

  @override
  void initState() {
    super.initState();
    _profileReady = _initializeProfile();
    _messageSubscription = FirebaseMessaging.onMessage.listen((message) {
      if (!mounted) return;
      final body =
          message.notification?.body ?? message.data['body'] as String?;
      if (body == null || body.isEmpty) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(body)));
    });
  }

  @override
  void dispose() {
    _messageSubscription?.cancel();
    super.dispose();
  }

  Future<void> _initializeProfile() async {
    await _functions.httpsCallable('initializeUserProfile').call({
      'role': 'customer',
      'displayName': widget.user.displayName ?? '',
    });
  }

  void _showError(Object error) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(_friendlyError(error))));
  }

  Future<void> _requestService(
    DocumentSnapshot<Map<String, dynamic>> service,
  ) async {
    final details = await _askForValue(
      context: context,
      title: 'Request ${service.data()?['name'] ?? 'service'}',
      label: 'Describe what you need (10–2000 characters)',
      multiline: true,
    );
    if (details == null) return;
    try {
      final result = await _functions
          .httpsCallable('createServiceRequest')
          .call({'serviceId': service.id, 'details': details.trim()});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Request ${result.data['orderId']} submitted.'),
          ),
        );
      }
    } catch (error) {
      _showError(error);
    }
  }

  Future<void> _signOut() async {
    await FirebaseAuth.instance.signOut();
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<void>(
    future: _profileReady,
    builder: (context, ready) {
      if (ready.hasError) {
        return Scaffold(
          appBar: AppBar(title: const Text('NADRIX')),
          body: _ErrorPanel(
            error: ready.error!,
            onRetry: () {
              setState(() => _profileReady = _initializeProfile());
            },
          ),
        );
      }
      if (ready.connectionState != ConnectionState.done) {
        return const Scaffold(body: Center(child: CircularProgressIndicator()));
      }
      return StreamBuilder<DocumentSnapshot<Map<String, dynamic>>>(
        stream: _db.collection('users').doc(widget.user.uid).snapshots(),
        builder: (context, profileSnapshot) {
          if (profileSnapshot.hasError) {
            return Scaffold(body: _ErrorPanel(error: profileSnapshot.error!));
          }
          final profile = profileSnapshot.data?.data();
          if (profile == null) {
            return const Scaffold(
              body: Center(child: CircularProgressIndicator()),
            );
          }
          final isAdmin = profile['role'] == 'admin';
          final pages = <Widget>[
            _HomeTab(onRequest: _requestService, onError: _showError),
            _OrdersTab(
              user: widget.user,
              isAdmin: isAdmin,
              onError: _showError,
            ),
            _NotificationsTab(
              userId: widget.user.uid,
              onError: _showError,
              onOpenRequests: () => setState(() => _tab = 1),
            ),
            _ProfileTab(
              user: widget.user,
              profile: profile,
              onSignOut: _signOut,
              onError: _showError,
            ),
            if (isAdmin) _AdminTab(onError: _showError),
          ];
          if (_tab >= pages.length) _tab = 0;
          return Scaffold(
            appBar: AppBar(
              title: const Text('NADRIX ZTECHNOLOGY'),
              actions: [
                Padding(
                  padding: const EdgeInsets.only(right: 12),
                  child: Center(
                    child: Text(
                      (profile['displayName'] as String?)?.isNotEmpty == true
                          ? profile['displayName'] as String
                          : widget.user.email ?? 'Account',
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ),
              ],
            ),
            body: SafeArea(child: pages[_tab]),
            bottomNavigationBar: NavigationBar(
              selectedIndex: _tab,
              onDestinationSelected: (index) => setState(() => _tab = index),
              destinations: [
                const NavigationDestination(
                  icon: Icon(Icons.home_outlined),
                  selectedIcon: Icon(Icons.home),
                  label: 'Home',
                ),
                const NavigationDestination(
                  icon: Icon(Icons.receipt_long_outlined),
                  selectedIcon: Icon(Icons.receipt_long),
                  label: 'Requests',
                ),
                const NavigationDestination(
                  icon: Icon(Icons.notifications_outlined),
                  selectedIcon: Icon(Icons.notifications),
                  label: 'Notifications',
                ),
                const NavigationDestination(
                  icon: Icon(Icons.person_outline),
                  selectedIcon: Icon(Icons.person),
                  label: 'Profile',
                ),
                if (isAdmin)
                  const NavigationDestination(
                    icon: Icon(Icons.admin_panel_settings_outlined),
                    selectedIcon: Icon(Icons.admin_panel_settings),
                    label: 'Admin',
                  ),
              ],
            ),
          );
        },
      );
    },
  );
}

class _HomeTab extends StatelessWidget {
  const _HomeTab({required this.onRequest, required this.onError});

  final Future<void> Function(DocumentSnapshot<Map<String, dynamic>>) onRequest;
  final ValueChanged<Object> onError;

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(18),
    children: [
      Text(
        'Business websites, student projects, and IT services.',
        style: Theme.of(context).textTheme.titleLarge,
      ),
      const SizedBox(height: 8),
      const Text('Choose a service to submit a secure request.'),
      const SizedBox(height: 18),
      Text('Services', style: Theme.of(context).textTheme.titleMedium),
      StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
        stream: FirebaseFirestore.instance
            .collection('services')
            .where('isActive', isEqualTo: true)
            .orderBy('sortOrder')
            .snapshots(),
        builder: (context, snapshot) {
          if (snapshot.hasError) return _ErrorPanel(error: snapshot.error!);
          if (!snapshot.hasData) {
            return const Padding(
              padding: EdgeInsets.all(28),
              child: Center(child: CircularProgressIndicator()),
            );
          }
          if (snapshot.data!.docs.isEmpty) {
            return const Text(
              'Services will appear after the administrator finishes setup.',
            );
          }
          return Column(
            children: snapshot.data!.docs.map((service) {
              final data = service.data();
              return Card(
                child: ListTile(
                  title: Text(data['name'] as String? ?? 'Service'),
                  subtitle: Text(data['description'] as String? ?? ''),
                  trailing: const Icon(Icons.arrow_forward, color: _teal),
                  onTap: () => onRequest(service),
                ),
              );
            }).toList(),
          );
        },
      ),
      const SizedBox(height: 18),
      Text('Projects', style: Theme.of(context).textTheme.titleMedium),
      StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
        stream: FirebaseFirestore.instance
            .collection('projects')
            .where('isPublished', isEqualTo: true)
            .orderBy('sortOrder')
            .limit(30)
            .snapshots(),
        builder: (context, snapshot) {
          if (snapshot.hasError) return _ErrorPanel(error: snapshot.error!);
          if (!snapshot.hasData) return const LinearProgressIndicator();
          if (snapshot.data!.docs.isEmpty) {
            return const Text('Published projects will appear here.');
          }
          return Column(
            children: snapshot.data!.docs.map((project) {
              final data = project.data();
              return Card(
                child: ListTile(
                  title: Text(data['title'] as String? ?? 'Project'),
                  subtitle: Text(data['description'] as String? ?? ''),
                ),
              );
            }).toList(),
          );
        },
      ),
    ],
  );
}

class _OrdersTab extends StatelessWidget {
  const _OrdersTab({
    required this.user,
    required this.isAdmin,
    required this.onError,
  });

  final User user;
  final bool isAdmin;
  final ValueChanged<Object> onError;

  @override
  Widget build(BuildContext context) {
    Query<Map<String, dynamic>> query = FirebaseFirestore.instance.collection(
      'orders',
    );
    if (!isAdmin) query = query.where('userId', isEqualTo: user.uid);
    return StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
      stream: query
          .orderBy('createdAt', descending: true)
          .limit(100)
          .snapshots(),
      builder: (context, snapshot) {
        if (snapshot.hasError) return _ErrorPanel(error: snapshot.error!);
        if (!snapshot.hasData) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.data!.docs.isEmpty) {
          return const Center(child: Text('No service requests yet.'));
        }
        return ListView(
          padding: const EdgeInsets.all(16),
          children: snapshot.data!.docs.map((order) {
            final data = order.data();
            return Card(
              child: ListTile(
                title: Text(
                  '${data['serviceName'] ?? 'Service'} · ${_status(data['status'])}',
                ),
                subtitle: Text(
                  '${data['details'] ?? ''}\n${isAdmin ? data['requesterEmail'] ?? '' : ''}',
                ),
                isThreeLine: isAdmin,
                trailing: isAdmin
                    ? PopupMenuButton<String>(
                        tooltip: 'Update request status',
                        onSelected: (status) =>
                            _updateOrder(order.id, status, onError),
                        itemBuilder: (context) => const [
                          PopupMenuItem(value: 'new', child: Text('New')),
                          PopupMenuItem(
                            value: 'in_progress',
                            child: Text('In progress'),
                          ),
                          PopupMenuItem(
                            value: 'completed',
                            child: Text('Completed'),
                          ),
                          PopupMenuItem(
                            value: 'cancelled',
                            child: Text('Cancelled'),
                          ),
                        ],
                      )
                    : null,
              ),
            );
          }).toList(),
        );
      },
    );
  }
}

class _NotificationsTab extends StatelessWidget {
  const _NotificationsTab({
    required this.userId,
    required this.onError,
    required this.onOpenRequests,
  });

  final String userId;
  final ValueChanged<Object> onError;
  final VoidCallback onOpenRequests;

  Future<void> _markAsRead(String notificationId) async {
    try {
      await FirebaseFirestore.instance
          .collection('users')
          .doc(userId)
          .collection('notifications')
          .doc(notificationId)
          .update({'readAt': FieldValue.serverTimestamp()});
    } catch (error) {
      onError(error);
    }
  }

  @override
  Widget build(BuildContext context) => StreamBuilder<
    QuerySnapshot<Map<String, dynamic>>
  >(
    stream: FirebaseFirestore.instance
        .collection('users')
        .doc(userId)
        .collection('notifications')
        .orderBy('createdAt', descending: true)
        .limit(50)
        .snapshots(),
    builder: (context, snapshot) {
      if (snapshot.hasError) return _ErrorPanel(error: snapshot.error!);
      if (!snapshot.hasData) {
        return const Center(child: CircularProgressIndicator());
      }
      if (snapshot.data!.docs.isEmpty) {
        return const Center(child: Text('No notifications yet.'));
      }
      return ListView(
        padding: const EdgeInsets.all(16),
        children: snapshot.data!.docs.map((notification) {
          final data = notification.data();
          final orderId = data['orderId'] as String?;
          final status = data['status'];
          final serviceName = data['serviceName'] as String? ?? 'NADRIX update';
          final createdAt = data['createdAt'];
          final timestamp = createdAt is Timestamp
              ? createdAt.toDate().toLocal().toString().split('.').first
              : 'Date unavailable';
          final subtitle = [
            if (orderId != null) 'Request #$orderId',
            if (status != null) _status(status),
            timestamp,
          ].join(' · ');
          return Card(
            child: ListTile(
              title: Text(serviceName),
              subtitle: Text(subtitle),
              onTap: orderId == null ? null : onOpenRequests,
              trailing: data['readAt'] == null
                  ? IconButton(
                      tooltip: 'Mark as read',
                      icon: const Icon(Icons.mark_email_read_outlined),
                      onPressed: () => _markAsRead(notification.id),
                    )
                  : const Icon(Icons.done, semanticLabel: 'Read'),
            ),
          );
        }).toList(),
      );
    },
  );
}

class _ProfileTab extends StatelessWidget {
  const _ProfileTab({
    required this.user,
    required this.profile,
    required this.onSignOut,
    required this.onError,
  });

  final User user;
  final Map<String, dynamic> profile;
  final Future<void> Function() onSignOut;
  final ValueChanged<Object> onError;

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(18),
    children: [
      Center(
        child: CircleAvatar(
          radius: 42,
          backgroundImage:
              profile['photoURL'] is String &&
                  (profile['photoURL'] as String).isNotEmpty
              ? NetworkImage(profile['photoURL'] as String)
              : null,
          child:
              profile['photoURL'] is String &&
                  (profile['photoURL'] as String).isNotEmpty
              ? null
              : const Icon(Icons.person, size: 40),
        ),
      ),
      const SizedBox(height: 12),
      Text(
        profile['displayName'] as String? ?? 'NADRIX user',
        style: Theme.of(context).textTheme.headlineSmall,
      ),
      const SizedBox(height: 6),
      Text(user.email ?? user.phoneNumber ?? user.uid),
      Text('Account type: ${profile['role'] ?? 'customer'}'),
      if (user.email != null && profile['emailVerified'] != true)
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('Email not verified'),
          subtitle: const Text('Verify your email to submit service requests.'),
          trailing: TextButton(
            onPressed: () async {
              try {
                await user.sendEmailVerification();
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('Verification email sent.')),
                  );
                }
              } catch (error) {
                onError(error);
              }
            },
            child: const Text('Send email'),
          ),
        ),
      const SizedBox(height: 12),
      FilledButton.tonalIcon(
        onPressed: () => _enablePush(user, onError),
        icon: const Icon(Icons.notifications_active_outlined),
        label: const Text('Enable push notifications'),
      ),
      const SizedBox(height: 8),
      OutlinedButton.icon(
        onPressed: () => _editDisplayName(context, user, onError),
        icon: const Icon(Icons.edit_outlined),
        label: const Text('Edit profile name'),
      ),
      OutlinedButton.icon(
        onPressed: () => _selectProfilePhoto(user, onError),
        icon: const Icon(Icons.photo_camera_outlined),
        label: const Text('Change profile photo'),
      ),
      if (user.email != null && profile['emailVerified'] != true)
        TextButton(
          onPressed: () => _refreshEmailVerification(user, onError),
          child: const Text('I verified my email — refresh status'),
        ),
      if (user.email != null &&
          profile['emailVerified'] == true &&
          profile['role'] != 'admin')
        TextButton(
          onPressed: () async {
            try {
              await FirebaseFunctions.instanceFor(
                region: _region,
              ).httpsCallable('claimInitialAdmin').call();
              await user.getIdToken(true);
            } catch (error) {
              onError(error);
            }
          },
          child: const Text('Set up first administrator (if configured)'),
        ),
      const SizedBox(height: 8),
      OutlinedButton.icon(
        onPressed: onSignOut,
        icon: const Icon(Icons.logout),
        label: const Text('Sign out'),
      ),
      const SizedBox(height: 8),
      TextButton.icon(
        onPressed: () => _deleteAccount(context, onError),
        icon: const Icon(Icons.delete_outline, color: Colors.redAccent),
        label: const Text(
          'Delete my account',
          style: TextStyle(color: Colors.redAccent),
        ),
      ),
    ],
  );
}

class _AdminTab extends StatelessWidget {
  const _AdminTab({required this.onError});

  final ValueChanged<Object> onError;

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(16),
    children: [
      Text('Administration', style: Theme.of(context).textTheme.headlineSmall),
      const SizedBox(height: 12),
      FutureBuilder<HttpsCallableResult<dynamic>>(
        future: FirebaseFunctions.instanceFor(
          region: _region,
        ).httpsCallable('getAdminSummary').call(),
        builder: (context, snapshot) {
          if (snapshot.hasError) return _ErrorPanel(error: snapshot.error!);
          if (!snapshot.hasData) return const LinearProgressIndicator();
          final summary = Map<String, dynamic>.from(snapshot.data!.data as Map);
          return Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _CountChip(label: 'Users', count: summary['users']),
              _CountChip(label: 'Requests', count: summary['orders']),
              _CountChip(label: 'Services', count: summary['services']),
              _CountChip(label: 'New', count: summary['newOrders']),
            ],
          );
        },
      ),
      const SizedBox(height: 22),
      Text('Services', style: Theme.of(context).textTheme.titleLarge),
      _AdminServices(onError: onError),
      const SizedBox(height: 12),
      FilledButton.tonalIcon(
        onPressed: () => _createService(context, onError),
        icon: const Icon(Icons.add),
        label: const Text('Add service'),
      ),
      const SizedBox(height: 22),
      Text('Projects', style: Theme.of(context).textTheme.titleLarge),
      _AdminProjects(onError: onError),
      const SizedBox(height: 12),
      FilledButton.tonalIcon(
        onPressed: () => _createProject(context, onError),
        icon: const Icon(Icons.add),
        label: const Text('Publish project'),
      ),
      const SizedBox(height: 22),
      Text('Users', style: Theme.of(context).textTheme.titleLarge),
      _AdminUsers(onError: onError),
    ],
  );
}

class _AdminServices extends StatelessWidget {
  const _AdminServices({required this.onError});

  final ValueChanged<Object> onError;

  @override
  Widget build(BuildContext context) =>
      StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
        stream: FirebaseFirestore.instance
            .collection('services')
            .orderBy('sortOrder')
            .limit(100)
            .snapshots(),
        builder: (context, snapshot) {
          if (snapshot.hasError) return _ErrorPanel(error: snapshot.error!);
          if (!snapshot.hasData) return const LinearProgressIndicator();
          return Column(
            children: snapshot.data!.docs.map((service) {
              final data = service.data();
              final active = data['isActive'] == true;
              return Card(
                child: ListTile(
                  title: Text(data['name'] as String? ?? 'Service'),
                  subtitle: Text(active ? 'Visible' : 'Hidden'),
                  trailing: PopupMenuButton<String>(
                    onSelected: (action) async {
                      try {
                        if (action == 'delete') {
                          await service.reference.delete();
                        } else {
                          await service.reference.update({
                            'isActive': !active,
                            'updatedAt': FieldValue.serverTimestamp(),
                          });
                        }
                      } catch (error) {
                        onError(error);
                      }
                    },
                    itemBuilder: (context) => [
                      PopupMenuItem(
                        value: 'toggle',
                        child: Text(active ? 'Hide' : 'Publish'),
                      ),
                      const PopupMenuItem(
                        value: 'delete',
                        child: Text('Delete'),
                      ),
                    ],
                  ),
                ),
              );
            }).toList(),
          );
        },
      );
}

class _AdminProjects extends StatelessWidget {
  const _AdminProjects({required this.onError});

  final ValueChanged<Object> onError;

  @override
  Widget build(BuildContext context) =>
      StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
        stream: FirebaseFirestore.instance
            .collection('projects')
            .orderBy('sortOrder')
            .limit(100)
            .snapshots(),
        builder: (context, snapshot) {
          if (snapshot.hasError) return _ErrorPanel(error: snapshot.error!);
          if (!snapshot.hasData) return const LinearProgressIndicator();
          return Column(
            children: snapshot.data!.docs.map((project) {
              final data = project.data();
              final published = data['isPublished'] == true;
              return Card(
                child: ListTile(
                  title: Text(data['title'] as String? ?? 'Project'),
                  subtitle: Text(published ? 'Published' : 'Draft'),
                  trailing: PopupMenuButton<String>(
                    onSelected: (action) async {
                      try {
                        if (action == 'delete') {
                          await project.reference.delete();
                        } else {
                          await project.reference.update({
                            'isPublished': !published,
                            'updatedAt': FieldValue.serverTimestamp(),
                          });
                        }
                      } catch (error) {
                        onError(error);
                      }
                    },
                    itemBuilder: (context) => [
                      PopupMenuItem(
                        value: 'toggle',
                        child: Text(published ? 'Unpublish' : 'Publish'),
                      ),
                      const PopupMenuItem(
                        value: 'delete',
                        child: Text('Delete'),
                      ),
                    ],
                  ),
                ),
              );
            }).toList(),
          );
        },
      );
}

class _AdminUsers extends StatelessWidget {
  const _AdminUsers({required this.onError});

  final ValueChanged<Object> onError;

  @override
  Widget build(
    BuildContext context,
  ) => StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
    stream: FirebaseFirestore.instance
        .collection('users')
        .orderBy('createdAt', descending: true)
        .limit(100)
        .snapshots(),
    builder: (context, snapshot) {
      if (snapshot.hasError) return _ErrorPanel(error: snapshot.error!);
      if (!snapshot.hasData) return const LinearProgressIndicator();
      final currentUid = FirebaseAuth.instance.currentUser?.uid;
      return Column(
        children: snapshot.data!.docs.map((user) {
          final data = user.data();
          final email = data['email'] as String? ?? user.id;
          return Card(
            child: ListTile(
              title: Text(data['displayName'] as String? ?? email),
              subtitle: Text(
                '$email · ${data['active'] == true ? 'Active' : 'Disabled'}',
              ),
              trailing: user.id == currentUid
                  ? null
                  : PopupMenuButton<String>(
                      onSelected: (value) =>
                          _updateUser(user.id, value, onError),
                      itemBuilder: (context) => [
                        for (final role in ['customer', 'student', 'admin'])
                          PopupMenuItem(
                            value: 'role:$role',
                            child: Text('Set $role'),
                          ),
                        PopupMenuItem(
                          value: data['active'] == true ? 'disable' : 'enable',
                          child: Text(
                            data['active'] == true
                                ? 'Disable account'
                                : 'Enable account',
                          ),
                        ),
                      ],
                    ),
            ),
          );
        }).toList(),
      );
    },
  );
}

class _CountChip extends StatelessWidget {
  const _CountChip({required this.label, required this.count});

  final String label;
  final Object? count;

  @override
  Widget build(BuildContext context) => Chip(label: Text('$label: $count'));
}

class _ErrorPanel extends StatelessWidget {
  const _ErrorPanel({required this.error, this.onRetry});

  final Object error;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(20),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(_friendlyError(error), textAlign: TextAlign.center),
        if (onRetry != null)
          TextButton(onPressed: onRetry, child: const Text('Retry')),
      ],
    ),
  );
}

Future<String?> _askForValue({
  required BuildContext context,
  required String title,
  required String label,
  String? hint,
  bool multiline = false,
}) async {
  final controller = TextEditingController();
  final result = await showDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: TextField(
        controller: controller,
        autofocus: true,
        maxLines: multiline ? 5 : 1,
        decoration: InputDecoration(labelText: label, hintText: hint),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, controller.text),
          child: const Text('Continue'),
        ),
      ],
    ),
  );
  controller.dispose();
  return result;
}

Future<void> _editDisplayName(
  BuildContext context,
  User user,
  ValueChanged<Object> onError,
) async {
  final name = await _askForValue(
    context: context,
    title: 'Edit profile',
    label: 'Display name',
  );
  if (name == null || name.trim().isEmpty) return;
  try {
    await user.updateDisplayName(name.trim());
    await FirebaseFirestore.instance.collection('users').doc(user.uid).update({
      'displayName': name.trim(),
      'updatedAt': FieldValue.serverTimestamp(),
    });
  } catch (error) {
    onError(error);
  }
}

Future<void> _selectProfilePhoto(
  User user,
  ValueChanged<Object> onError,
) async {
  try {
    final file = await ImagePicker().pickImage(
      source: ImageSource.gallery,
      maxWidth: 1600,
      maxHeight: 1600,
      imageQuality: 85,
    );
    if (file == null) return;
    final extension = file.name.split('.').last.toLowerCase();
    final contentType = switch (file.mimeType) {
      'image/jpeg' => 'image/jpeg',
      'image/png' => 'image/png',
      'image/webp' => 'image/webp',
      _ => switch (extension) {
        'jpg' || 'jpeg' => 'image/jpeg',
        'png' => 'image/png',
        'webp' => 'image/webp',
        _ => null,
      },
    };
    if (contentType == null) {
      throw StateError('Choose a JPEG, PNG, or WebP profile image.');
    }
    if (await file.length() > 5 * 1024 * 1024) {
      throw StateError('Profile images must be smaller than 5 MB.');
    }
    final object = FirebaseStorage.instance.ref(
      'profile-images/${user.uid}/${DateTime.now().microsecondsSinceEpoch}.$extension',
    );
    await object.putData(
      await file.readAsBytes(),
      SettableMetadata(contentType: contentType),
    );
    final photoURL = await object.getDownloadURL();
    await user.updatePhotoURL(photoURL);
    await FirebaseFirestore.instance.collection('users').doc(user.uid).update({
      'photoURL': photoURL,
      'updatedAt': FieldValue.serverTimestamp(),
    });
  } catch (error) {
    onError(error);
  }
}

Future<void> _refreshEmailVerification(
  User user,
  ValueChanged<Object> onError,
) async {
  try {
    await user.reload();
    final refreshedUser = FirebaseAuth.instance.currentUser!;
    await refreshedUser.getIdToken(true);
    await FirebaseFunctions.instanceFor(
      region: _region,
    ).httpsCallable('initializeUserProfile').call({
      'role': 'customer',
      'displayName': refreshedUser.displayName ?? '',
    });
  } catch (error) {
    onError(error);
  }
}

Future<void> _enablePush(User user, ValueChanged<Object> onError) async {
  try {
    final messaging = FirebaseMessaging.instance;
    final permission = await messaging.requestPermission();
    if (permission.authorizationStatus == AuthorizationStatus.denied) {
      throw StateError(
        'Notification permission was denied in device settings.',
      );
    }
    // The Admin SDK's multicast API requires an FCM registration token, not an FID.
    // ignore: deprecated_member_use
    final token = await messaging.getToken();
    if (token == null || token.isEmpty) {
      throw StateError('Firebase did not return a push token.');
    }
    final deviceId = base64Url.encode(utf8.encode(token)).replaceAll('=', '');
    await FirebaseFirestore.instance
        .collection('users')
        .doc(user.uid)
        .collection('devices')
        .doc(deviceId)
        .set({
          'token': token,
          'platform': Platform.isIOS ? 'ios' : 'android',
          'updatedAt': FieldValue.serverTimestamp(),
        });
  } catch (error) {
    onError(error);
  }
}

Future<void> _deleteAccount(
  BuildContext context,
  ValueChanged<Object> onError,
) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('Delete account?'),
      content: const Text(
        'This permanently deletes your account and service requests.',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, true),
          child: const Text('Delete'),
        ),
      ],
    ),
  );
  if (confirmed != true) return;
  try {
    await FirebaseFunctions.instanceFor(
      region: _region,
    ).httpsCallable('deleteMyAccount').call();
    await FirebaseAuth.instance.signOut();
  } catch (error) {
    onError(error);
  }
}

Future<void> _updateOrder(
  String orderId,
  String status,
  ValueChanged<Object> onError,
) async {
  try {
    await FirebaseFunctions.instanceFor(region: _region)
        .httpsCallable('updateServiceRequest')
        .call({'orderId': orderId, 'status': status});
  } catch (error) {
    onError(error);
  }
}

Future<void> _updateUser(
  String uid,
  String action,
  ValueChanged<Object> onError,
) async {
  try {
    final functions = FirebaseFunctions.instanceFor(region: _region);
    if (action.startsWith('role:')) {
      await functions.httpsCallable('setUserRole').call({
        'uid': uid,
        'role': action.substring('role:'.length),
      });
    } else {
      await functions.httpsCallable('setUserActive').call({
        'uid': uid,
        'active': action == 'enable',
      });
    }
  } catch (error) {
    onError(error);
  }
}

Future<void> _createService(
  BuildContext context,
  ValueChanged<Object> onError,
) async {
  final name = await _askForValue(
    context: context,
    title: 'New service',
    label: 'Name',
  );
  if (!context.mounted || name == null || name.trim().length < 2) return;
  final description = await _askForValue(
    context: context,
    title: 'New service',
    label: 'Description',
  );
  if (!context.mounted || description == null || description.trim().isEmpty) {
    return;
  }
  try {
    final collection = FirebaseFirestore.instance.collection('services');
    final existing = await collection
        .orderBy('sortOrder', descending: true)
        .limit(1)
        .get();
    final nextOrder = existing.docs.isEmpty
        ? 0
        : (existing.docs.first.data()['sortOrder'] as int) + 1;
    await collection.add({
      'name': name.trim(),
      'description': description.trim(),
      'isActive': true,
      'sortOrder': nextOrder,
      'createdAt': FieldValue.serverTimestamp(),
      'updatedAt': FieldValue.serverTimestamp(),
    });
  } catch (error) {
    onError(error);
  }
}

Future<void> _createProject(
  BuildContext context,
  ValueChanged<Object> onError,
) async {
  final title = await _askForValue(
    context: context,
    title: 'New project',
    label: 'Title',
  );
  if (!context.mounted || title == null || title.trim().isEmpty) return;
  final description = await _askForValue(
    context: context,
    title: 'New project',
    label: 'Description',
    multiline: true,
  );
  if (!context.mounted || description == null || description.trim().isEmpty) {
    return;
  }
  try {
    final collection = FirebaseFirestore.instance.collection('projects');
    final existing = await collection
        .orderBy('sortOrder', descending: true)
        .limit(1)
        .get();
    final nextOrder = existing.docs.isEmpty
        ? 0
        : (existing.docs.first.data()['sortOrder'] as int) + 1;
    await collection.add({
      'title': title.trim(),
      'description': description.trim(),
      'isPublished': true,
      'sortOrder': nextOrder,
      'createdAt': FieldValue.serverTimestamp(),
      'updatedAt': FieldValue.serverTimestamp(),
    });
  } catch (error) {
    onError(error);
  }
}

String _status(Object? value) => switch (value) {
  'in_progress' => 'In progress',
  'completed' => 'Completed',
  'cancelled' => 'Cancelled',
  _ => 'New',
};

String _friendlyError(Object error) {
  if (error is FirebaseAuthException) return error.message ?? error.code;
  if (error is FirebaseException) return error.message ?? error.code;
  if (error is FirebaseFunctionsException) return error.message ?? error.code;
  return error.toString().replaceFirst('Bad state: ', '');
}
