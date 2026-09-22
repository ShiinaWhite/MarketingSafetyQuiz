package com.jty.safetyquiz;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Capacitor 自定义插件必须在 Bridge 初始化（super.onCreate）之前注册，
        // 否则注册会被静默忽略，WebView 内 getPlugin("…") 返回 null。
        registerPlugin(OcrPlugin.class);
        registerPlugin(InAppCameraPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
