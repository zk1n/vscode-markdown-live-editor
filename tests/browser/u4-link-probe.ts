import "../../src/webview/editor.js";

const bootstrap = document.getElementById("markdown-live-editor-bootstrap");
const source = bootstrap?.textContent.includes("u4-link-source") === true;
if (source) {
  const trigger = (): void => {
    const link = document.querySelectorAll<HTMLElement>(".cm-live-preview-link")[1];
    if (
      link !== undefined &&
      document.querySelector('.cm-content[contenteditable="true"]') !== null
    ) {
      observer.disconnect();
      const rect = link.getBoundingClientRect();
      link.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          button: 0,
          ctrlKey: true,
          clientX: rect.left + Math.max(1, rect.width / 2),
          clientY: rect.top + Math.max(1, rect.height / 2),
        }),
      );
    }
  };
  const observer = new MutationObserver(trigger);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["contenteditable"],
  });
  trigger();
}
