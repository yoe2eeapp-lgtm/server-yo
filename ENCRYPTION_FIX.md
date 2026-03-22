# Yo! v2 — Encryption Fix + UI Upgrade

## What changed

### Encryption (CRITICAL FIX)
The old crypto used different keys to encrypt vs decrypt — fixed!

New protocol uses **Diffie-Hellman style shared secret**:
- Alice encrypts: shared = SHA256(alice_private + bob_public)  
- Bob decrypts:   shared = SHA256(bob_private + alice_public)
- Both get SAME shared secret ✓
- Messages fully encrypted, both sides can read ✓

### Files to replace

| File in zip          | Replace in app                              |
|----------------------|---------------------------------------------|
| crypto_v2.ts         | src/lib/crypto.ts                           |
| server_v2.js         | Upload to Railway (replace server.js)       |

Plus all the UI files from before if not replaced yet:
| LoginScreen.tsx      | src/screens/LoginScreen.tsx                 |
| SignupScreen.tsx      | src/screens/SignupScreen.tsx                |
| ChatScreen.tsx       | src/screens/ChatScreen.tsx                  |
| ChatsTab.tsx         | src/screens/tabs/ChatsTab.tsx               |
| ProfileTab.tsx       | src/screens/tabs/ProfileTab.tsx             |
| AppearanceScreen.tsx | src/screens/AppearanceScreen.tsx            |
| MainTabs.tsx         | src/screens/MainTabs.tsx                    |
| theme_index.ts       | src/theme/index.ts                          |

## IMPORTANT: Delete old database

Since the message schema changed (encrypted_key → sender_public_key),
you need to delete the old database on Railway so it recreates fresh:

In Railway → your service → go to the terminal/shell:
```
rm /opt/render/project/src/yo.db
```
Or just redeploy — the DB will recreate automatically.

Everyone will need to sign up again (fresh accounts).

## Rebuild app after replacing files

```powershell
cd "W:\YO App\yo-final_2\yo-final\app"
New-Item -ItemType Directory -Force -Path "android\app\src\main\assets"
npx expo export:embed --platform android --entry-file index.js --bundle-output android\app\src\main\assets\index.android.bundle --assets-dest android\app\src\main\res --dev false
$env:ANDROID_HOME = "C:\Users\Vanam\AppData\Local\Android\Sdk"
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
cd android
.\gradlew assembleRelease
```
