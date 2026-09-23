package com.jty.safetyquiz;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * SELF_UPDATE_V1 原生更新插件。
 *
 * 职责（全部在 App 进程内完成，不借助外部应用）：
 * 1. 原生流式下载 APK 到 cacheDir/updates/（绝不整包进 JS 内存/base64）
 * 2. 下载过程中流式计算 SHA-256，完成后与 manifest 比对
 * 3. PackageManager.getPackageArchiveInfo 实际解析 APK：校验 packageName/versionCode
 * 4. 下载包签名证书与当前运行应用比对（SHA-256 digest），不一致拒绝安装
 * 5. canRequestPackageInstalls 检查 + 引导系统"安装未知应用"设置页
 * 6. FileProvider content:// URI 调起 Android 系统 Package Installer（不静默安装）
 */
@CapacitorPlugin(name = "UpdatePlugin")
public class UpdatePlugin extends Plugin {

    private static final String UPDATE_DIR = "updates";
    private static final String TMP_NAME = "update.apk.tmp";
    private static final String FINAL_NAME = "update.apk";
    private static final long PROGRESS_INTERVAL_MS = 500;
    private static final long PROGRESS_INTERVAL_BYTES = 1024L * 1024;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    private File updateDir() {
        return new File(getContext().getCacheDir(), UPDATE_DIR);
    }

    private File tmpFile() {
        return new File(updateDir(), TMP_NAME);
    }

    private File finalFile() {
        return new File(updateDir(), FINAL_NAME);
    }

    private void cleanupFiles() {
        File[] files = {tmpFile(), finalFile()};
        for (File f : files) {
            if (f.exists() && !f.delete()) {
                // 尽力清理；删除失败时后续写入/校验仍会拦截
            }
        }
    }

    @PluginMethod
    public void downloadUpdate(final PluginCall call) {
        final String url = call.getString("url");
        final String expectedSha256 = call.getString("sha256");
        final String expectedPackageName = call.getString("expectedPackageName");
        final Integer expectedVersionCode = call.getInt("expectedVersionCode");
        final Long expectedSize = call.getLong("expectedSize") != null ? call.getLong("expectedSize") : null;
        if (url == null || expectedSha256 == null || expectedPackageName == null) {
            call.reject("url/sha256/expectedPackageName 必填", "BAD_ARGS");
            return;
        }
        executor.execute(new Runnable() {
            @Override
            public void run() {
                File tmp = tmpFile();
                try {
                    if (!updateDir().exists() && !updateDir().mkdirs()) {
                        call.reject("无法创建更新目录", "IO_ERROR");
                        return;
                    }
                    cleanupFiles();

                    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setConnectTimeout(10_000);
                    conn.setReadTimeout(30_000);
                    conn.setInstanceFollowRedirects(true);
                    int status = conn.getResponseCode();
                    if (status < 200 || status >= 300) {
                        conn.disconnect();
                        cleanupFiles();
                        call.reject("下载失败 HTTP " + status, "HTTP_ERROR");
                        return;
                    }
                    long contentLength = conn.getContentLengthLong();
                    if (!UpdateVerifier.contentLengthAcceptable(contentLength, UpdateVerifier.MAX_APK_BYTES)) {
                        conn.disconnect();
                        cleanupFiles();
                        call.reject("更新包超过大小上限", "TOO_LARGE");
                        return;
                    }

                    MessageDigest md = MessageDigest.getInstance("SHA-256");
                    InputStream in = conn.getInputStream();
                    FileOutputStream out = new FileOutputStream(tmp);
                    byte[] buf = new byte[64 * 1024];
                    long total = 0;
                    long lastNotifyMs = 0;
                    long lastNotifyBytes = 0;
                    int n;
                    try {
                        while ((n = in.read(buf)) > 0) {
                            total += n;
                            if (total > UpdateVerifier.MAX_APK_BYTES) {
                                call.reject("更新包超过大小上限", "TOO_LARGE");
                                return;
                            }
                            md.update(buf, 0, n);
                            out.write(buf, 0, n);
                            long now = System.currentTimeMillis();
                            if (now - lastNotifyMs >= PROGRESS_INTERVAL_MS
                                    || total - lastNotifyBytes >= PROGRESS_INTERVAL_BYTES) {
                                lastNotifyMs = now;
                                lastNotifyBytes = total;
                                JSObject p = new JSObject();
                                p.put("downloadedBytes", total);
                                p.put("totalBytes", contentLength > 0 ? contentLength : 0);
                                p.put("percent", contentLength > 0 ? (int) (total * 100 / contentLength) : 0);
                                notifyListeners("updateDownloadProgress", p);
                            }
                        }
                    } finally {
                        try { in.close(); } catch (Exception e) { /* 尽力关闭 */ }
                        try { out.close(); } catch (Exception e) { /* 尽力关闭 */ }
                        conn.disconnect();
                    }

                    String actualSha256 = UpdateVerifier.sha256Hex(md.digest());
                    if (!UpdateVerifier.sha256Matches(expectedSha256, actualSha256)) {
                        cleanupFiles();
                        call.reject("更新包校验失败（SHA256 不一致）", "SHA_MISMATCH");
                        return;
                    }
                    if (expectedSize != null && expectedSize > 0 && expectedSize != total) {
                        cleanupFiles();
                        call.reject("更新包大小与 manifest 不一致", "SIZE_MISMATCH");
                        return;
                    }

                    PackageManager pm = getContext().getPackageManager();
                    PackageInfo archive = pm.getPackageArchiveInfo(
                            tmp.getAbsolutePath(), PackageManager.GET_SIGNATURES);
                    if (archive == null || archive.packageName == null) {
                        cleanupFiles();
                        call.reject("更新包无法解析", "PARSE_FAILED");
                        return;
                    }
                    if (!UpdateVerifier.packageMatches(expectedPackageName, archive.packageName)) {
                        cleanupFiles();
                        call.reject("更新包与应用不匹配（packageName 不一致）", "PACKAGE_MISMATCH");
                        return;
                    }
                    if (expectedVersionCode != null
                            && archive.versionCode != expectedVersionCode.intValue()) {
                        cleanupFiles();
                        call.reject("更新包版本与 manifest 不一致", "VERSION_MISMATCH");
                        return;
                    }
                    Set<String> currentDigests = currentSignerDigests(pm);
                    Set<String> archiveDigests = archiveSignerDigests(archive);
                    if (!UpdateVerifier.sameSignerSha256(currentDigests, archiveDigests)) {
                        cleanupFiles();
                        call.reject("更新包签名不一致", "SIGNER_MISMATCH");
                        return;
                    }

                    if (!tmp.renameTo(finalFile())) {
                        cleanupFiles();
                        call.reject("更新包保存失败", "IO_ERROR");
                        return;
                    }

                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    ret.put("verified", true);
                    ret.put("packageName", archive.packageName);
                    ret.put("versionCode", archive.versionCode);
                    ret.put("versionName", archive.versionName);
                    ret.put("size", total);
                    ret.put("sha256", actualSha256);
                    call.resolve(ret);
                } catch (Exception e) {
                    cleanupFiles();
                    call.reject("下载失败：" + e.getMessage(), "DOWNLOAD_FAILED");
                }
            }
        });
    }

    /** 当前运行应用的签名证书 SHA-256 digest 集合。 */
    private Set<String> currentSignerDigests(PackageManager pm) throws Exception {
        Set<String> out = new HashSet<String>();
        if (Build.VERSION.SDK_INT >= 28) {
            PackageInfo pi = pm.getPackageInfo(getContext().getPackageName(),
                    PackageManager.GET_SIGNING_CERTIFICATES);
            if (pi != null && pi.signingInfo != null) {
                // 本应用为单签名；getSigningCertificateHistory 返回历史+当前证书，
                // 当前证书即最后一个元素，取全部做 digest 集合比对即可
                Signature[] sigs = pi.signingInfo.getSigningCertificateHistory();
                out.addAll(digestsOf(sigs));
            }
        }
        if (out.isEmpty()) {
            // API < 28 兜底：deprecated GET_SIGNATURES 仍返回有效证书
            @SuppressWarnings("deprecation")
            PackageInfo pi = pm.getPackageInfo(getContext().getPackageName(),
                    PackageManager.GET_SIGNATURES);
            if (pi != null && pi.signatures != null) {
                out.addAll(digestsOf(pi.signatures));
            }
        }
        return out;
    }

    private static Set<String> archiveSignerDigests(PackageInfo archive) {
        Set<String> out = new HashSet<String>();
        if (archive.signatures != null) {
            out.addAll(digestsOf(archive.signatures));
        }
        return out;
    }

    private static Set<String> digestsOf(Signature[] sigs) {
        Set<String> out = new HashSet<String>();
        if (sigs == null) {
            return out;
        }
        for (Signature s : sigs) {
            try {
                out.add(UpdateVerifier.sha256Hex(
                        MessageDigest.getInstance("SHA-256").digest(s.toByteArray())));
            } catch (Exception e) {
                // 单个证书摘要失败时跳过，集合为空会导致签名校验拒绝（fail-closed）
            }
        }
        return out;
    }

    @PluginMethod
    public void canInstallUpdates(PluginCall call) {
        boolean can = true;
        if (Build.VERSION.SDK_INT >= 26) {
            can = getContext().getPackageManager().canRequestPackageInstalls();
        }
        JSObject ret = new JSObject();
        ret.put("canInstall", can);
        call.resolve(ret);
    }

    @PluginMethod
    public void openInstallPermissionSettings(final PluginCall call) {
        if (Build.VERSION.SDK_INT < 26) {
            JSObject ret = new JSObject();
            ret.put("opened", false);
            call.resolve(ret);
            return;
        }
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + getContext().getPackageName()));
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getActivity().startActivity(intent);
                    JSObject ret = new JSObject();
                    ret.put("opened", true);
                    call.resolve(ret);
                } catch (Exception e) {
                    call.reject("无法打开安装权限设置", "SETTINGS_FAILED");
                }
            }
        });
    }

    /** 调起 Android 系统 Package Installer（content:// URI + 读授权）。 */
    @PluginMethod
    public void installDownloadedUpdate(PluginCall call) {
        final File apk = finalFile();
        if (!apk.exists() || apk.length() == 0) {
            call.reject("没有已下载并通过校验的更新包", "NO_UPDATE");
            return;
        }
        try {
            final Uri uri = FileProvider.getUriForFile(getContext(),
                    getContext().getPackageName() + ".fileprovider", apk);
            getActivity().runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        Intent intent = new Intent(Intent.ACTION_INSTALL_PACKAGE);
                        intent.setDataAndType(uri, "application/vnd.android.package-archive");
                        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                                | Intent.FLAG_ACTIVITY_NEW_TASK);
                        getActivity().startActivity(intent);
                        JSObject ret = new JSObject();
                        ret.put("ok", true);
                        call.resolve(ret);
                    } catch (Exception e) {
                        call.reject("无法启动系统安装器", "INSTALL_FAILED");
                    }
                }
            });
        } catch (Exception e) {
            call.reject("无法生成安装包 URI", "INSTALL_FAILED");
        }
    }

    @PluginMethod
    public void clearDownloadedUpdate(PluginCall call) {
        cleanupFiles();
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }
}
