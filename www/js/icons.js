/* icons.js —— UI_DESIGN_V1 统一内联 SVG 图标。
   24 viewBox / stroke 1.8 / round cap+join / currentColor / aria-hidden。
   仅静态字符串，无外部依赖、无网络加载；供 index.html 静态壳与 app.js render 层使用。
   内容级符号（√ × A/B/C/D）不属于 UI 图标，不在此定义。 */
(function (root) {
  "use strict";

  var PATHS = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/>',
    camera: '<path d="M4 8.5C4 7.4 4.9 6.5 6 6.5h1.6l1.2-1.7c.3-.4.7-.6 1.2-.6h4c.5 0 .9.2 1.2.6l1.2 1.7H18c1.1 0 2 .9 2 2v8.4c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2Z"/><circle cx="12" cy="12.6" r="3.4"/>',
    back: '<path d="m14.5 5.5-6.2 6.5 6.2 6.5"/>',
    chevronDown: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
    check: '<path d="m5 12.5 4.6 4.6L19 7.5"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 3.5v3.7h-3.7"/>',
    trash: '<path d="M5 7h14M10 7V5.6c0-.6.5-1.1 1.1-1.1h1.8c.6 0 1.1.5 1.1 1.1V7m3.5 0-.7 11.1c-.1 1-.9 1.9-2 1.9H9.2c-1.1 0-1.9-.9-2-1.9L6.5 7"/>',
    download: '<path d="M12 4v10.5m0 0 4.2-4.2M12 14.5 7.8 10.3"/><path d="M5 17.5v.5c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2v-.5"/>',
    edit: '<path d="m14.5 5.5 4 4L8 20H4v-4Z"/><path d="m12.5 7.5 4 4"/>',
    alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5"/><circle cx="12" cy="15.8" r=".4" fill="currentColor" stroke="none"/>',
    history: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    searchOff: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8M8.2 11h5.6"/>',
    flag: '<path d="M6 21V4.5C8.5 3 11 3 13.5 4.5S18.5 6 19.5 4.5V13c-1 1.5-3.5 1.5-6 0S8.5 11.5 6 13"/>',
    shield: '<path d="M12 3.5 5.5 6v5c0 4.4 2.8 7.6 6.5 9.5 3.7-1.9 6.5-5.1 6.5-9.5V6Z"/><path d="m9 11.8 2.2 2.2L15.5 9.5"/>'
  };

  /* 返回完整 <svg> 字符串（仅用于 innerHTML 注入静态图标，禁止拼接任何动态内容） */
  function svg(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (PATHS[name] || "") + "</svg>";
  }

  /* 返回独立 SVG DOM 节点；cls 可选（用 setAttribute，SVG className 只读） */
  function el(name, cls) {
    var holder = document.createElement("span");
    holder.innerHTML = svg(name);
    var node = holder.firstChild;
    if (cls) { node.setAttribute("class", cls); }
    return node;
  }

  root.MSQIcons = {
    svg: svg,
    el: el,
    has: function (name) { return Object.prototype.hasOwnProperty.call(PATHS, name); }
  };
})(typeof self !== "undefined" ? self : this);
