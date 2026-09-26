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
 * 1. 原生流式下载 APK 到 cacheDir/updates/update-vc&lt;versionCode&gt;.apk
 *    （版本化文件名：旧包残留不可能被安装路径复用；绝不整包进 JS 内存/base64）
 * 2. 下载过程中流式计算 SHA-256，完成后与 manifest 比对
 * 3. PackageManager.getPackageArchiveInfo 实际解析 APK：校验 packageName/versionCode
 * 4. 下载包签名证书与当前运行应用比对（SHA-256 digest），不一致拒绝安装
 * 5. canRequestPackageInstalls 检查 + 引导系统"安装未知应用"设置页
 * 6. installDownloadedUpdate 在调起安装器前对最终文件做第二次全量校验
 *    （SHA256 + packageName + versionCode + 签名），然后 FileProvider content://
 *    URI 调起 Android 系统 Package Installer（不静默安装）
 */
@CapacitorPlugin(name = "UpdatePlugin")
public class UpdatePlugin extends Plugin {

    private static final String UPDATE_DIR = "updates";
    private static final String LEGACY_FINAL_NAME = "update.apk";
    private static final String TMP_PREFIX = "update.apk.tmp";
    private static final long PROGRESS_INTERVAL_MS = 500;
    private static final long PROGRESS_INTERVAL_BYTES = 1024L * 1024;

    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    /** APK_CDN_STABILITY_DIAG_V1：解析腾讯 CDN 明确缓存指标（实测 X-Cache-Lookup:
     *  Cache Hit / Cache Miss）。拿不到或其它值 → unknown，绝不猜测。 */
    private static String cacheStatusOf(HttpURLConnection conn) {
        String v = conn.getHeaderField("X-Cache-Lookup");
        if (v == null || v.isEmpty()) { v = conn.getHeaderField("X-Cache"); }
        if (v == null || v.isEmpty()) { return "unknown"; }
        String low = v.toLowerCase();
        if (low.contains("hit")) { return "hit"; }
        if (low.contains("miss")) { return "miss"; }
        return "unknown";
    }

    private File updateDir() {
        return new File(getContext().getCacheDir(), UPDATE_DIR);
    }

    private File finalFile(long versionCode) {
        return new File(updateDir(), UpdateVerifier.updateFileName(versionCode));
    }

    /** 删除目录内全部更新包残留（旧固定名 update.apk / 旧版本 update-vc*.apk / tmp）。 */
    private void cleanupUpdatesDir() {
        File dir = updateDir();
        File[] files = dir.listFiles();
        if (files == null) { return; }
        for (File f : files) {
            final String name = f.getName();
            if (name.startsWith("update") && (name.endsWith(".apk") || name.contains(".apk.tmp"))) {
                // 删除失败不阻塞：安装前还有第二次全量校验兜底
                f.delete();
            }
        }
    }

    @PluginMethod
    public void downloadUpdate(final PluginCall call) {
        final String url = call.getString("url");
        final String expectedSha256 = call.getString("sha256");
        final String expectedPackageName = call.getString("expectedPackageName");
        final Integer expectedVersionCode = call.getInt("expectedVersionCode");
        /* APK_DELIVERY_COS_CDN_VC13_V1：多态解析，Integer/Long/Double/整数字符串
           都可靠转 long（修复 getLong 对 Integer 返回 null 的历史陷阱） */
        final Long expectedSize = UpdateVerifier.flexibleLong(
                call.getLong("expectedSize"), call.getDouble("expectedSize"),
                call.getString("expectedSize"));
        if (url == null || expectedSha256 == null || expectedPackageName == null
                || expectedVersionCode == null) {
            // versionCode 必填：绝不允许跳过版本一致性校验
            call.reject("url/sha256/expectedPackageName/expectedVersionCode 必填", "BAD_ARGS");
            return;
        }
        final File tmp = new File(updateDir(), UpdateVerifier.updateFileName(expectedVersionCode) + ".tmp");
        final File finalFile = finalFile(expectedVersionCode);
        executor.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    if (!updateDir().exists() && !updateDir().mkdirs()) {
                        call.reject("无法创建更新目录", "IO_ERROR");
                        return;
                    }
                    cleanupUpdatesDir();

                    long startedAt = System.currentTimeMillis();   /* 非敏感诊断：耗时/速率 */
                    HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setConnectTimeout(10_000);
                    conn.setReadTimeout(30_000);
                    conn.setInstanceFollowRedirects(true);
                    int status = conn.getResponseCode();
                    if (status < 200 || status >= 300) {
                        conn.disconnect();
                        cleanupUpdatesDir();
                        call.reject("下载失败 HTTP " + status, "HTTP_ERROR");
                        return;
                    }
                    String cacheStatus = cacheStatusOf(conn);
                    long contentLength = conn.getContentLengthLong();
                    if (!UpdateVerifier.contentLengthAcceptable(contentLength, UpdateVerifier.MAX_APK_BYTES)) {
                        conn.disconnect();
                        cleanupUpdatesDir();
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

                    JSObject verify = verifyApkFile(call, tmp, expectedSha256, expectedPackageName,
                            expectedVersionCode, expectedSize);
                    if (verify == null) {
                        cleanupUpdatesDir();
                        call.reject("更新包校验失败", "VERIFY_FAILED");
                        return;
                    }
                    if (!tmp.renameTo(finalFile)) {
                        cleanupUpdatesDir();
                        call.reject("更新包保存失败", "IO_ERROR");
                        return;
                    }

                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    ret.put("verified", true);
                    ret.put("packageName", verify.getString("packageName"));
                    ret.put("versionCode", verify.getInt("versionCode"));
                    ret.put("versionName", verify.getString("versionName"));
                    ret.put("size", total);
                    ret.put("sha256", UpdateVerifier.sha256Hex(md.digest()));
                    ret.put("absolutePath", finalFile.getAbsolutePath());
                    /* APK_CDN_STABILITY_DIAG_V1：非敏感下载诊断（只进 DEV 诊断页）。
                       绝不含 URL/域名/凭据；host 标签由 JS 侧根据 primary/fallback 判定。 */
                    long downloadMs = System.currentTimeMillis() - startedAt;
                    ret.put("httpStatus", status);
                    ret.put("downloadMs", downloadMs);
                    ret.put("bytes", total);
                    ret.put("bytesPerSec", downloadMs > 0 ? (total * 1000 / downloadMs) : 0);
                    ret.put("cacheStatus", cacheStatus);
                    call.resolve(ret);
                } catch (Exception e) {
                    cleanupUpdatesDir();
                    call.reject("下载失败：" + e.getMessage(), "DOWNLOAD_FAILED");
                }
            }
        });
    }

    /**
     * 对指定文件执行全量校验（SHA256 + size + 包名 + versionCode + 签名）。
     * 全部通过返回 {packageName, versionCode, versionName, size, sha256}；
     * 任一失败直接 call.reject（带具体错误码）并返回 null。
     */
    private JSObject verifyApkFile(final PluginCall call, File apk, String expectedSha256,
                                   String expectedPackageName, Integer expectedVersionCode,
                                   Long expectedSize) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        java.io.FileInputStream in = new java.io.FileInputStream(apk);
        byte[] buf = new byte[64 * 1024];
        long total = 0;
        int n;
        try {
            while ((n = in.read(buf)) > 0) {
                total += n;
                md.update(buf, 0, n);
            }
        } finally {
            try { in.close(); } catch (Exception e) { /* 尽力关闭 */ }
        }
        String actualSha256 = UpdateVerifier.sha256Hex(md.digest());
        if (!UpdateVerifier.sha256Matches(expectedSha256, actualSha256)) {
            call.reject("更新包校验失败（SHA256 不一致）", "SHA_MISMATCH");
            return null;
        }
        if (expectedSize != null && expectedSize > 0 && expectedSize != total) {
            call.reject("更新包大小与 manifest 不一致", "SIZE_MISMATCH");
            return null;
        }
        PackageManager pm = getContext().getPackageManager();
        PackageInfo archive = pm.getPackageArchiveInfo(
                apk.getAbsolutePath(), PackageManager.GET_SIGNATURES);
        if (archive == null || archive.packageName == null) {
            call.reject("更新包无法解析", "PARSE_FAILED");
            return null;
        }
        if (!UpdateVerifier.packageMatches(expectedPackageName, archive.packageName)) {
            call.reject("更新包与应用不匹配（packageName 不一致）", "PACKAGE_MISMATCH");
            return null;
        }
        if (expectedVersionCode == null
                || archive.versionCode != expectedVersionCode.intValue()
                || archive.versionCode <= getInstalledVersionCode(pm)) {
            call.reject("更新包版本校验失败", "VERSION_MISMATCH");
            return null;
        }
        Set<String> currentDigests = currentSignerDigests(pm);
        Set<String> archiveDigests = archiveSignerDigests(archive);
        if (!UpdateVerifier.sameSignerSha256(currentDigests, archiveDigests)) {
            call.reject("更新包签名不一致", "SIGNER_MISMATCH");
            return null;
        }
        JSObject ret = new JSObject();
        ret.put("packageName", archive.packageName);
        ret.put("versionCode", archive.versionCode);
        ret.put("versionName", archive.versionName);
        ret.put("size", total);
        ret.put("sha256", actualSha256);
        return ret;
    }

    private int getInstalledVersionCode(PackageManager pm) {
        try {
            PackageInfo pi = pm.getPackageInfo(getContext().getPackageName(), 0);
            return pi != null ? pi.versionCode : 0;
        } catch (Exception e) {
            return 0;
        }
    }

    /** 当前运行应用的签名证书 SHA-256 digest 集合。 */
    private Set<String> currentSignerDigests(PackageManager pm) throws Exception {
        Set<String> out = new HashSet<String>();
        if (Build.VERSION.SDK_INT >= 28) {
            PackageInfo pi = pm.getPackageInfo(getContext().getPackageName(),
                    PackageManager.GET_SIGNING_CERTIFICATES);
            if (pi != null && pi.signingInfo != null) {
                // 本应用为单签名；getSigningCertificateHistory 返回历史+当前证书
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

    /**
     * 调起系统安装器前，对最终文件做第二次全量校验（与 downloadUpdate 相同标准），
     * 然后以 FileProvider content:// URI + 读授权启动 Android Package Installer。
     * 必填：expectedPackageName / expectedVersionCode / sha256。
     */
    @PluginMethod
    public void installDownloadedUpdate(final PluginCall call) {
        final String expectedSha256 = call.getString("sha256");
        final String expectedPackageName = call.getString("expectedPackageName");
        final Integer expectedVersionCode = call.getInt("expectedVersionCode");
        if (expectedSha256 == null || expectedPackageName == null || expectedVersionCode == null) {
            call.reject("sha256/expectedPackageName/expectedVersionCode 必填", "BAD_ARGS");
            return;
        }
        final File apk = finalFile(expectedVersionCode);
        if (!apk.exists() || apk.length() == 0) {
            call.reject("没有已下载并通过校验的更新包，请重新下载", "NO_UPDATE");
            return;
        }
        executor.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    final JSObject verify = verifyApkFile(call, apk, expectedSha256,
                            expectedPackageName, expectedVersionCode, null);
                    if (verify == null) {
                        cleanupUpdatesDir();   /* 校验失败的文件绝不进入安装器 */
                        return;
                    }
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
                                ret.put("packageName", verify.getString("packageName"));
                                ret.put("versionCode", verify.getInt("versionCode"));
                                ret.put("versionName", verify.getString("versionName"));
                                ret.put("absolutePath", apk.getAbsolutePath());
                                ret.put("fileProviderUri", uri.toString());
                                call.resolve(ret);
                            } catch (Exception e) {
                                call.reject("无法启动系统安装器", "INSTALL_FAILED");
                            }
                        }
                    });
                } catch (Exception e) {
                    cleanupUpdatesDir();
                    call.reject("安装前校验失败：" + e.getMessage(), "VERIFY_FAILED");
                }
            }
        });
    }

    @PluginMethod
    public void clearDownloadedUpdate(PluginCall call) {
        cleanupUpdatesDir();
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }
}
