// <script src="https://cdn.settlekit.dev/button.js" data-link="plink_7Hk2"></script>
// The price lives in the payment link, never in this tag, so a buyer can't edit it.
(function () {
  var script = document.currentScript;
  var link = script && script.getAttribute("data-link");
  if (!link) return;

  var dark = script.getAttribute("data-theme") === "dark";
  var button = document.createElement("a");
  button.href = new URL(script.src).origin + "/l/" + encodeURIComponent(link);
  button.textContent = script.getAttribute("data-label") || "Pay with USDT";
  button.style.cssText =
    "display:inline-block;padding:12px 22px;border-radius:8px;font:600 15px/1.2 system-ui,sans-serif;" +
    "text-decoration:none;background:" + (dark ? "#f5f5f4" : "#1c1917") + ";color:" + (dark ? "#1c1917" : "#fff");
  script.parentNode.insertBefore(button, script.nextSibling);
})();
