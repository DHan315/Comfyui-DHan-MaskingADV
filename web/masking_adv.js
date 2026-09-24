import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
  name: "MaskingADV",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    const comfyNodeName = nodeData?.name ?? nodeType?.comfyClass;
    if (comfyNodeName !== "MaskingADV") return;
    const proto = nodeType?.prototype;
    if (!proto) return;

    // ComfyUI frontend 1.49.x keeps both the live combo widget and the
    // registered node input definition as media-validation sources of truth.
    // Images created after /object_info was loaded (paste/drop/transforms)
    // must be registered in both places or Bypass -> Always can flag them as
    // missing even though the input file exists and previews correctly.
    function registerImageValue(widget, value) {
      if (!widget?.options || typeof value !== "string" || !value) return;
      const values = widget.options.values;
      if (Array.isArray(values)) {
        if (!values.includes(value)) values.push(value);
      } else if (values == null) {
        widget.options.values = [value];
      }
    }

    function registerImageInNodeDefinition(value) {
      const imageDef = nodeData?.input?.required?.image;
      if (!Array.isArray(imageDef) || !Array.isArray(imageDef[0])) return;
      if (!imageDef[0].includes(value)) imageDef[0].push(value);
    }

    function disableMaskingADVUploadPreview() {
      const imageDef = nodeData?.input?.required?.image ?? nodeData?.input?.optional?.image;
      const imageOptions = Array.isArray(imageDef) && imageDef[1] && typeof imageDef[1] === "object" ? imageDef[1] : null;
      if (!imageOptions) return;

      // Nodes 2.0 uses these upload flags to switch the combo into the full
      // media picker, which renders its own thumbnail preview below the inline
      // editor. This node already owns image upload/drop/paste and preview UI.
      imageOptions.image_upload = false;
      imageOptions.animated_image_upload = false;
      imageOptions.video_upload = false;
    }

    disableMaskingADVUploadPreview();

    function syncTrackedImage(node, widget, value) {
      if (!node || !widget || typeof value !== "string" || !value) return;
      registerImageValue(widget, value);
      registerImageInNodeDefinition(value);
      widget.value = value;
      node.widgets_values = node.widgets?.map(w => w.value);
    }

    function refreshTrackedMedia(node) {
      const widget = node?.widgets?.find(w => w.name === "image");
      const value = widget?.value;
      if (typeof value !== "string" || !value) return;

      const reassert = () => {
        if (!node.graph) return;
        node.hideOutputImages = true;
        syncTrackedImage(node, widget, value);
        widget.callback?.(value);
        node.imgs = [];
        node.imageIndex = null;
        node.setDirtyCanvas?.(true, true);
        app.graph?.setDirtyCanvas?.(true, true);
      };

      queueMicrotask(reassert);
      requestAnimationFrame(() => requestAnimationFrame(reassert));
    }

    const onNodeCreated = proto.onNodeCreated;
    const onResize = proto.onResize;
    const onConfigure = proto.onConfigure;
    const onModeChange = proto.onModeChange;

    proto.onConfigure = function (...args) {
      const result = onConfigure?.apply(this, args);
      refreshTrackedMedia(this);
      return result;
    };

    proto.onModeChange = function (...args) {
      const result = onModeChange?.apply(this, args);
      refreshTrackedMedia(this);
      return result;
    };

    proto.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);

      const node = this;

      function suppressBuiltInPreview() {
        try {
          Object.defineProperty(node, "imgs", {
            configurable: true,
            get: () => [],
            set: () => {},
          });
          Object.defineProperty(node, "imageIndex", {
            configurable: true,
            get: () => null,
            set: () => {},
          });
        } catch {
          node.imgs = [];
          node.imageIndex = null;
        }
        node.onDrawBackground = () => {};
        node.onDrawForeground = () => {};
      }

      suppressBuiltInPreview();

      const imageWidget = node.widgets?.find(w => w.name === "image");
      const maskWidget = node.widgets?.find(w => w.name === "mask_data");

      if (maskWidget) {
        maskWidget.type = "hidden";
        maskWidget.computeSize = () => [0, -4];
      }

      if (imageWidget) {
        imageWidget.computeSize = () => [220, 24];
        imageWidget.draw = () => {};
        if (imageWidget.spec && typeof imageWidget.spec === "object") {
          imageWidget.spec.image_upload = false;
          imageWidget.spec.animated_image_upload = false;
          imageWidget.spec.video_upload = false;
        }
        imageWidget.options ??= {};
        imageWidget.options.showPreview = false;
        imageWidget.options.hidePreview = true;
      }

      function suppressOutputPreview() {
        // Nodes 2.0 renders IMAGE outputs as Vue node content below widgets.
        // This node already owns its inline preview/editor, so opt out of that.
        node.hideOutputImages = true;
      }

      suppressOutputPreview();

      const BRUSH_STORAGE_KEY = "comfyui.masking_adv.brush_size";
      const storedBrush = Number(localStorage.getItem(BRUSH_STORAGE_KEY));
      let brushSize = Number.isFinite(storedBrush) ? Math.min(100, Math.max(1, storedBrush)) : 30;

      let tool = "paint";
      let isDrawing = false;
      let lastPoint = null;
      let selectionStart = null;
      let selectionCurrent = null;
      let lassoPoints = [];
      let selectionOperation = "paint";

      let sourceImg = null;
      let previewImg = null;
      let imageRect = null;
      let resizing = false;

      let quarterTurns = 0;
      let fineRotation = 0;
      let mirrorX = false;
      let mirrorY = false;
      let zoom = 1;
      let panX = 0;
      let panY = 0;
      let isPanning = false;
      let panStart = null;
      let panMoved = false;
      let lastMiddleClickTime = 0;
      let maskExplicit = false;
      let pointerInPreview = false;
      let brushCursorPoint = null;

      let W = 320;
      let H = 200;

      const controlsH = 56;
      const controlsGap = 8;
      const minNodeW = 220;
      const minPreviewW = 120;
      const minPreviewH = 72;
      const measuredWidgetH = minPreviewH + controlsGap + controlsH;
      const nodeTopPadding = 112;
      const nodeBottomPadding = 12;
      const workspacePadding = 36;

      const outer = document.createElement("div");
      Object.assign(outer.style, {
        width: "100%",
        position: "relative",
        display: "block",
        overflow: "visible",
        marginTop: "6px",
        marginBottom: "0",
        boxSizing: "border-box",
      });

      const wrapper = document.createElement("div");
      Object.assign(wrapper.style, {
        position: "absolute",
        left: "50%",
        top: "0",
        transform: "translateX(-50%)",
        border: "none",
        background: "transparent",
        overflow: "hidden",
        boxSizing: "border-box",
      });

      const previewCanvas = document.createElement("canvas");
      const maskCanvas = document.createElement("canvas");
      for (const canvas of [previewCanvas, maskCanvas]) {
        Object.assign(canvas.style, {
          position: "absolute",
          left: "0",
          top: "0",
          width: "100%",
          touchAction: "none",
        });
      }
      wrapper.title = "Mouse wheel: fine zoom • Ctrl+wheel: coarse zoom • Middle mouse drag: pan • Double middle-click: fit";
      maskCanvas.style.pointerEvents = "none";

      const pctx = previewCanvas.getContext("2d");
      const mctx = maskCanvas.getContext("2d");
      const realMask = document.createElement("canvas");
      const rctx = realMask.getContext("2d");

      const style = document.createElement("style");
      style.textContent = `
        .inline-mask-ui button {
          appearance: none;
          -webkit-appearance: none;
          border: 1px solid #555;
          border-radius: 4px;
          background: #353535;
          color: #f2f2f2;
          box-shadow: none;
          outline: none;
          transition: background-color 120ms ease, border-color 120ms ease;
        }
        .inline-mask-ui button:hover {
          background: #444;
          border-color: #666;
        }
        .inline-mask-ui button:active {
          box-shadow: none;
          transform: none;
        }
        .inline-mask-ui button.inline-active {
          background: #f58220;
          border-color: #f58220;
          color: #fff;
        }
        .inline-mask-ui input[type="range"] {
          appearance: none;
          -webkit-appearance: none;
          height: 18px;
          background: transparent;
          cursor: pointer;
        }
        .inline-mask-ui input[type="range"]::-webkit-slider-runnable-track {
          height: 3px;
          background: #fff;
          border-radius: 0;
          border: 0;
        }
        .inline-mask-ui input[type="range"]::-webkit-slider-thumb {
          appearance: none;
          -webkit-appearance: none;
          width: 12px;
          height: 12px;
          margin-top: -4.5px;
          border-radius: 50%;
          border: 0;
          background: #f58220;
          box-shadow: none;
        }
        .inline-mask-ui input[type="range"]::-moz-range-track {
          height: 3px;
          background: #fff;
          border: 0;
          border-radius: 0;
        }
        .inline-mask-ui input[type="range"]::-moz-range-thumb {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          border: 0;
          background: #f58220;
          box-shadow: none;
        }
      `;
      outer.classList.add("inline-mask-ui");
      outer.appendChild(style);

      const controls = document.createElement("div");
      Object.assign(controls.style, {
        position: "absolute",
        left: "0",
        width: "100%",
        height: `${controlsH}px`,
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        padding: "4px",
        boxSizing: "border-box",
        background: "#2b2b2b",
      });

      const row1 = document.createElement("div");
      const row2 = document.createElement("div");
      for (const row of [row1, row2]) {
        Object.assign(row.style, {
          display: "flex",
          width: "100%",
          gap: "3px",
          alignItems: "center",
          minWidth: "0",
        });
      }

      function makeButton(label, title = "") {
        const btn = document.createElement("button");
        btn.textContent = label;
        btn.title = title;
        Object.assign(btn.style, {
          fontSize: "10px",
          padding: "2px 4px",
          lineHeight: "16px",
          minHeight: "20px",
          minWidth: "0",
          flex: "1 1 0",
          overflow: "hidden",
          whiteSpace: "nowrap",
          textOverflow: "ellipsis",
        });
        return btn;
      }

      const ICONS = {
        brush: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20c2.8-.2 4.6-1.4 5.4-3.7.5-1.5.4-2.8 1.6-4l6.9-6.9c.8-.8 2-.8 2.7 0 .8.8.8 2 0 2.7l-6.9 6.9c-1.2 1.2-2.5 1.1-4 1.6C7.4 17.4 6.2 19.2 6 22"/><path d="M13.2 10.1l2.7 2.7"/></svg>`,
        eraser: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7.5 17.5-3-3a2 2 0 0 1 0-2.8l7.2-7.2a2 2 0 0 1 2.8 0l5 5a2 2 0 0 1 0 2.8l-5.2 5.2H7.5Z"/><path d="m10 7 7 7M13.5 17.5H21"/></svg>`,
        marquee: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4M4 9V5a1 1 0 0 1 1-1" stroke-dasharray="2 2"/></svg>`,
        lasso: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.2 5.5C3.8 7 3 8.8 3 10.7c0 4.1 3.9 7.3 9 7.3 4.9 0 9-2.8 9-6.6 0-3.7-4-6.4-9.1-6.4-2.5 0-4.8.6-6.7 1.7"/><path d="M12.1 18c.2 2.1 1.5 3.2 3.4 3.2 1.7 0 3-1 3-2.2 0-1.1-.9-1.8-2.1-1.8-1.1 0-1.9.6-1.9 1.4 0 .7.5 1.2 1.3 1.2"/><path d="M5.2 5.5 3.8 3.8"/></svg>`,
        fillMask: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1" style="fill:currentColor;stroke:currentColor"/></svg>`,
        trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>`,
        rotateLeft: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8V4L2 7l3 3V8a8 8 0 1 1-1 7"/></svg>`,
        rotateRight: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 8V4l3 3-3 3V8a8 8 0 1 0 1 7"/></svg>`,
        flipH: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M10 6 4 9v6l6 3V6ZM14 6l6 3v6l-6 3V6Z"/></svg>`,
        flipV: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h18M6 10l3-6h6l3 6H6ZM6 14l3 6h6l3-6H6Z"/></svg>`,
        reset: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4v6h6"/><path d="M5.5 9A8 8 0 1 1 4 15"/></svg>`,
        copy: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-10A1.5 1.5 0 0 0 3 5.5v10A1.5 1.5 0 0 0 4.5 17H8"/></svg>`,
      };

      function makeIconButton(icon, title) {
        const btn = document.createElement("button");
        btn.innerHTML = icon;
        btn.title = title;
        btn.setAttribute("aria-label", title);
        Object.assign(btn.style, {
          padding: "1px 4px",
          lineHeight: "16px",
          minHeight: "22px",
          minWidth: "0",
          flex: "1 1 0",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          color: "currentColor",
        });
        const svg = btn.querySelector("svg");
        Object.assign(svg.style, {
          width: "16px",
          height: "16px",
          display: "block",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.7",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          pointerEvents: "none",
        });
        return btn;
      }

      const paintBtn = makeIconButton(ICONS.brush, "Brush mask");
      const eraseBtn = makeIconButton(ICONS.eraser, "Erase mask");
      const rectBtn = makeIconButton(ICONS.marquee, "Rectangle selection. Hold Alt while dragging to subtract.");
      const lassoBtn = makeIconButton(ICONS.lasso, "Freehand lasso. Hold Alt while dragging to subtract.");
      const fillBtn = makeIconButton(ICONS.fillMask, "Fill Mask: create a visible full mask for reverse masking with Eraser");
      const clearBtn = makeIconButton(ICONS.trash, "Clear custom mask and return to the invisible full-image mask");

      const sizeInput = document.createElement("input");
      sizeInput.type = "range";
      sizeInput.min = "1";
      sizeInput.max = "100";
      sizeInput.value = String(brushSize);
      sizeInput.title = `Brush size: ${brushSize}`;
      Object.assign(sizeInput.style, {
        flex: "1.8 1 80px",
        minWidth: "60px",
      });

      const rotLBtn = makeIconButton(ICONS.rotateLeft, "Rotate 90° counterclockwise");
      const rotRBtn = makeIconButton(ICONS.rotateRight, "Rotate 90° clockwise");
      const mirrorHBtn = makeIconButton(ICONS.flipH, "Flip horizontally");
      const mirrorVBtn = makeIconButton(ICONS.flipV, "Flip vertically");
      const resetBtn = makeIconButton(ICONS.reset, "Reset orientation");
      const copyBtn = makeIconButton(ICONS.copy, "Copy image");

      const rotationSlider = document.createElement("input");
      rotationSlider.type = "range";
      rotationSlider.min = "-180";
      rotationSlider.max = "180";
      rotationSlider.step = "0.1";
      rotationSlider.value = "0";
      rotationSlider.title = "Rotation (-180° to 180°)";
      Object.assign(rotationSlider.style, {
        flex: "2 1 100px",
        minWidth: "70px",
      });

      const rotationValue = document.createElement("span");
      rotationValue.textContent = "0.0°";
      Object.assign(rotationValue.style, {
        fontSize: "10px",
        minWidth: "38px",
        textAlign: "center",
        userSelect: "none",
      });

      row1.append(sizeInput, paintBtn, eraseBtn, rectBtn, lassoBtn, fillBtn, clearBtn);
      row2.append(rotLBtn, rotationSlider, rotationValue, rotRBtn, mirrorHBtn, mirrorVBtn, resetBtn, copyBtn);
      controls.append(row1, row2);
      wrapper.append(previewCanvas, maskCanvas, controls);
      outer.appendChild(wrapper);

      if (typeof node.addDOMWidget !== "function") {
        console.warn("MaskingADV requires ComfyUI DOM widget support; mask controls were not mounted.");
        return;
      }

      const domWidget = node.addDOMWidget("inline_mask_canvas", "div", outer, {
        serialize: false,
        hideOnZoom: false,
      });
      // Report a stable minimum to ComfyUI. Using node.size here creates a
      // one-way resize ratchet: after growing, the current height becomes the
      // widget minimum and the node can no longer be made smaller.
      domWidget.computeSize = () => [minNodeW - 20, measuredWidgetH + 8];

      function markChanged() {
        node.widgets_values = node.widgets?.map(w => w.value);
        node.setDirtyCanvas?.(true, true);
        app.graph.setDirtyCanvas(true, true);
      }

      function minNodeH() {
        return nodeTopPadding + minPreviewH + controlsGap + controlsH + nodeBottomPadding;
      }

      function enforceNodeSize() {
        // Only guard against unusably small dimensions. User resizing owns the maximum.
        if (resizing) return;
        resizing = true;
        node.size[0] = Math.max(node.size[0], minNodeW);
        node.size[1] = Math.max(node.size[1], minNodeH());
        resizing = false;
        app.graph.setDirtyCanvas(true, true);
      }

      function outputDimensions(img) {
        const oddQuarterTurn = Math.abs(quarterTurns % 2) === 1;
        return {
          width: oddQuarterTurn ? img.height : img.width,
          height: oddQuarterTurn ? img.width : img.height,
        };
      }

      function makeTransformedImage(img) {
        if (!img) return null;
        const dims = outputDimensions(img);
        const canvas = document.createElement("canvas");
        canvas.width = dims.width;
        canvas.height = dims.height;

        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const totalRotation = quarterTurns * 90 + fineRotation;
        ctx.translate(canvas.width / 2 + panX, canvas.height / 2 + panY);
        if (mirrorX) ctx.scale(-1, 1);
        if (mirrorY) ctx.scale(1, -1);
        ctx.rotate(totalRotation * Math.PI / 180);
        ctx.scale(zoom, zoom);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);
        return canvas;
      }

      function resetReframe() {
        zoom = 1;
        panX = 0;
        panY = 0;
      }

      function updateButtonStyles() {
        for (const [btn, name] of [[paintBtn, "paint"], [eraseBtn, "erase"], [rectBtn, "rect"], [lassoBtn, "lasso"]]) {
          btn.classList.toggle("inline-active", tool === name);
          btn.style.fontWeight = "normal";
        }
        mirrorHBtn.classList.toggle("inline-active", mirrorX);
        mirrorVBtn.classList.toggle("inline-active", mirrorY);
        setWrapperCursor();
      }

      function brushCursorEnabled() {
        return pointerInPreview && previewImg && imageRect && (tool === "paint" || tool === "erase") && !isPanning;
      }

      function setWrapperCursor() {
        if (isPanning) {
          wrapper.style.cursor = "grabbing";
        } else if (brushCursorEnabled()) {
          wrapper.style.cursor = "none";
        } else if (pointerInPreview && previewImg) {
          wrapper.style.cursor = "crosshair";
        } else {
          wrapper.style.cursor = "default";
        }
      }

      function setPreviewFromSource({ resetMask = true } = {}) {
        previewImg = makeTransformedImage(sourceImg);
        if (resetMask) resetRealMaskToImageSize();
        setCanvasSizeFromNode();
        redrawPreview();
        updateButtonStyles();
        markChanged();
        saveMask();
        scheduleTransformedImageUpload();
      }

      function configureDisplayCanvas(canvas, ctx, cssW, cssH) {
        // Keep the node's CSS footprint unchanged, but render the preview to a
        // higher-resolution backing canvas. This gives the browser more pixels
        // to downsample from when the node is made small, which keeps fine image
        // detail noticeably cleaner/sharper without touching the actual IMAGE
        // output or mask resolution.
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const previewScale = Math.max(dpr, 2.0);

        // Avoid runaway backing-store sizes on very large nodes / high-DPI screens.
        const maxBackingDimension = 4096;
        const scale = Math.min(
          previewScale,
          maxBackingDimension / Math.max(1, cssW),
          maxBackingDimension / Math.max(1, cssH)
        );

        canvas.width = Math.max(1, Math.round(cssW * scale));
        canvas.height = Math.max(1, Math.round(cssH * scale));
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
      }

      function setCanvasSizeFromNode() {
        // The viewport follows the node dimensions independently. The image is fit inside it.
        W = Math.max(minPreviewW, Math.floor(node.size[0] - 40));
        H = Math.max(minPreviewH, Math.floor(node.size[1] - nodeTopPadding - controlsGap - controlsH - nodeBottomPadding));

        outer.style.height = `${measuredWidgetH}px`;
        wrapper.style.width = `${W}px`;
        wrapper.style.height = `${H + controlsGap + controlsH}px`;
        configureDisplayCanvas(previewCanvas, pctx, W, H);
        configureDisplayCanvas(maskCanvas, mctx, W, H);
        redrawPreview();
        saveMask();
      }

      function resetRealMaskToImageSize() {
        if (!previewImg) return;
        realMask.width = previewImg.width;
        realMask.height = previewImg.height;
        rctx.fillStyle = "black";
        rctx.fillRect(0, 0, realMask.width, realMask.height);
        maskExplicit = false;
      }

      function beginExplicitMask() {
        if (maskExplicit) return;
        maskExplicit = true;
        rctx.fillStyle = "black";
        rctx.fillRect(0, 0, realMask.width, realMask.height);
      }

      function fillRealMask() {
        if (!realMask.width || !realMask.height) return;
        maskExplicit = true;
        rctx.fillStyle = "white";
        rctx.fillRect(0, 0, realMask.width, realMask.height);
      }

      function clearRealMask() {
        if (!realMask.width || !realMask.height) return;
        maskExplicit = false;
        rctx.fillStyle = "black";
        rctx.fillRect(0, 0, realMask.width, realMask.height);
      }

      function saveMask() {
        if (!maskWidget || !realMask.width || !realMask.height) return;
        maskWidget.value = maskExplicit ? realMask.toDataURL("image/png") : "";
        node.widgets_values = node.widgets?.map(w => w.value);
      }

      function getImageDrawRect() {
        if (!previewImg) return null;
        // Keep an editing workspace around the image so strokes and selections can
        // begin outside the image and sweep cleanly across its edges.
        const pad = Math.min(workspacePadding, Math.max(8, Math.min(W, H) * 0.12));
        const availableW = Math.max(1, W - pad * 2);
        const availableH = Math.max(1, H - pad * 2);
        const scale = Math.min(availableW / previewImg.width, availableH / previewImg.height);
        const iw = previewImg.width * scale;
        const ih = previewImg.height * scale;
        return { x: (W - iw) / 2, y: (H - ih) / 2, w: iw, h: ih, scale };
      }

      function layoutControls() {
        const controlsTop = imageRect ? imageRect.y + imageRect.h + controlsGap : H + controlsGap;
        controls.style.top = `${Math.max(0, Math.min(controlsTop, H + controlsGap))}px`;
      }

      function redrawPreview() {
        pctx.clearRect(0, 0, W, H);
        wrapper.style.background = "transparent";
        if (previewImg) {
          imageRect = getImageDrawRect();
          pctx.fillStyle = "#000";
          pctx.fillRect(imageRect.x, imageRect.y, imageRect.w, imageRect.h);
          pctx.drawImage(previewImg, imageRect.x, imageRect.y, imageRect.w, imageRect.h);
        } else {
          imageRect = null;
          pctx.fillStyle = "#888";
          pctx.font = "13px sans-serif";
          pctx.textAlign = "center";
          pctx.fillText("Drop / paste / select image", W / 2, H / 2);
        }
        layoutControls();
        redrawMaskOverlay();
      }

      function redrawMaskOverlay() {
        mctx.clearRect(0, 0, W, H);
        if (previewImg && imageRect && realMask.width && realMask.height) {
          const overlay = document.createElement("canvas");
          overlay.width = realMask.width;
          overlay.height = realMask.height;
          const octx = overlay.getContext("2d");
          const maskData = rctx.getImageData(0, 0, realMask.width, realMask.height);
          const data = maskData.data;
          for (let i = 0; i < data.length; i += 4) {
            const v = data[i];
            if (v > 0) {
              data[i] = 255; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 120;
            } else data[i + 3] = 0;
          }
          octx.putImageData(maskData, 0, 0);
          mctx.drawImage(overlay, imageRect.x, imageRect.y, imageRect.w, imageRect.h);
        }
        drawSelectionPreview();
        drawBrushCursor();
      }

      function drawBrushCursor() {
        if (!brushCursorEnabled() || !brushCursorPoint) return;
        const { x, y } = brushCursorPoint;
        if (x < 0 || x > W || y < 0 || y > H) return;

        const radius = Math.max(0.5, brushSize / 2);
        mctx.save();
        mctx.setLineDash([]);
        mctx.beginPath();
        mctx.arc(x, y, radius, 0, Math.PI * 2);
        mctx.lineWidth = 3;
        mctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
        mctx.stroke();
        mctx.beginPath();
        mctx.arc(x, y, radius, 0, Math.PI * 2);
        mctx.lineWidth = 1.5;
        mctx.strokeStyle = tool === "erase" ? "rgba(255, 255, 255, 0.95)" : "rgba(255, 130, 32, 0.95)";
        mctx.stroke();
        mctx.restore();
      }

      function drawSelectionPreview() {
        if (!isDrawing || !imageRect) return;
        mctx.save();

        // Gestures may start and continue in the padded workspace, but the
        // visible marquee/lasso outline should appear only over the image.
        mctx.beginPath();
        mctx.rect(imageRect.x, imageRect.y, imageRect.w, imageRect.h);
        mctx.clip();

        mctx.strokeStyle = "white";
        mctx.lineWidth = 1;
        mctx.setLineDash([5, 4]);
        if (tool === "rect" && selectionStart && selectionCurrent) {
          const a = imageToCanvas(selectionStart);
          const b = imageToCanvas(selectionCurrent);
          mctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        } else if (tool === "lasso" && lassoPoints.length > 1) {
          mctx.beginPath();
          const first = imageToCanvas(lassoPoints[0]);
          mctx.moveTo(first.x, first.y);
          for (let i = 1; i < lassoPoints.length; i++) {
            const p = imageToCanvas(lassoPoints[i]);
            mctx.lineTo(p.x, p.y);
          }
          mctx.stroke();
        }
        mctx.restore();
      }

      function getImagePoint(e) {
        if (!imageRect || !previewImg) return null;
        const { x: canvasX, y: canvasY } = getCanvasPoint(e);
        // Deliberately return unclamped image coordinates. The real mask canvas
        // clips paint and selections to valid pixels, while pointer capture lets
        // the gesture continue beyond the padded workspace and node bounds.
        return {
          x: ((canvasX - imageRect.x) / imageRect.w) * previewImg.width,
          y: ((canvasY - imageRect.y) / imageRect.h) * previewImg.height,
        };
      }

      function getCanvasPoint(e) {
        const rect = maskCanvas.getBoundingClientRect();
        return {
          x: ((e.clientX - rect.left) / rect.width) * W,
          y: ((e.clientY - rect.top) / rect.height) * H,
        };
      }

      function imageToCanvas(p) {
        return { x: imageRect.x + p.x * imageRect.scale, y: imageRect.y + p.y * imageRect.scale };
      }

      function scaledBrushSize() {
        return imageRect ? brushSize / imageRect.scale : brushSize;
      }

      function stamp(point, op = tool) {
        if (!point) return;
        rctx.beginPath();
        rctx.arc(point.x, point.y, scaledBrushSize() / 2, 0, Math.PI * 2);
        rctx.fillStyle = op === "erase" ? "black" : "white";
        rctx.fill();
      }

      function drawLine(from, to, op = tool) {
        if (!from || !to) return;
        rctx.beginPath();
        rctx.moveTo(from.x, from.y);
        rctx.lineTo(to.x, to.y);
        rctx.lineWidth = scaledBrushSize();
        rctx.lineCap = "round";
        rctx.lineJoin = "round";
        rctx.strokeStyle = op === "erase" ? "black" : "white";
        rctx.stroke();
        stamp(to, op);
      }

      function drawBrush(e) {
        if (!isDrawing) return;
        const p = getImagePoint(e);
        if (!p) { lastPoint = null; return; }
        if (lastPoint) drawLine(lastPoint, p, tool);
        else stamp(p, tool);
        lastPoint = p;
        redrawMaskOverlay();
        saveMask();
      }

      function applySelection() {
        rctx.save();
        rctx.fillStyle = selectionOperation === "erase" ? "black" : "white";
        if (tool === "rect" && selectionStart && selectionCurrent) {
          const x = Math.min(selectionStart.x, selectionCurrent.x);
          const y = Math.min(selectionStart.y, selectionCurrent.y);
          rctx.fillRect(x, y, Math.abs(selectionCurrent.x - selectionStart.x), Math.abs(selectionCurrent.y - selectionStart.y));
        } else if (tool === "lasso" && lassoPoints.length > 2) {
          rctx.beginPath();
          rctx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
          for (let i = 1; i < lassoPoints.length; i++) rctx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
          rctx.closePath();
          rctx.fill();
        }
        rctx.restore();
      }

      function imageValueFromUploadResponse(data) {
        const name = data.name || data.filename;
        const subfolder = data.subfolder || "";
        return name ? (subfolder ? `${subfolder}/${name}` : name) : null;
      }

      async function uploadCanvasAsInputImage(canvas, prefix = "inline_mask_transformed") {
        if (!canvas || !imageWidget) return null;
        const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
        if (!blob) return null;
        const file = new File([blob], `${prefix}_${Date.now()}.png`, { type: "image/png" });
        const formData = new FormData();
        formData.append("image", file);
        formData.append("type", "input");
        formData.append("overwrite", "true");
        const response = await fetch(api.apiURL("/upload/image"), { method: "POST", body: formData });
        if (!response.ok) return null;
        return imageValueFromUploadResponse(await response.json());
      }

      let transformUploadTimer = null;
      let internalImageWidgetUpdate = false;
      function scheduleTransformedImageUpload() {
        if (!previewImg || !imageWidget) return;
        if (transformUploadTimer) clearTimeout(transformUploadTimer);
        transformUploadTimer = setTimeout(async () => {
          const value = await uploadCanvasAsInputImage(previewImg);
          if (!value) return;
          internalImageWidgetUpdate = true;
          syncTrackedImage(node, imageWidget, value);
          setTimeout(() => { internalImageWidgetUpdate = false; }, 0);
          app.graph.setDirtyCanvas(true, true);
        }, 180);
      }

      async function uploadFile(file) {
        const formData = new FormData();
        formData.append("image", file);
        formData.append("type", "input");
        formData.append("overwrite", "false");
        const response = await fetch(api.apiURL("/upload/image"), { method: "POST", body: formData });
        if (!response.ok) return;
        const value = imageValueFromUploadResponse(await response.json());
        if (!value || !imageWidget) return;
        // Register first, then assign. This makes pasted/dropped media survive
        // frontend 1.49.x validation when the node leaves bypass.
        syncTrackedImage(node, imageWidget, value);
        imageWidget.callback?.(value);
        app.graph?.change?.();
        setTimeout(loadCurrentImagePreview, 150);
      }

      function handleFileList(files) {
        const file = files ? [...files].find(f => f.type.startsWith("image/")) : null;
        if (file) uploadFile(file);
      }

      async function copyPreviewImage() {
        if (!previewImg) return;
        const canvas = document.createElement("canvas");
        canvas.width = previewImg.width;
        canvas.height = previewImg.height;
        canvas.getContext("2d").drawImage(previewImg, 0, 0);
        canvas.toBlob(async blob => {
          if (!blob) return;
          try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); }
          catch (err) { console.warn("MaskingADV copy image failed:", err); }
        }, "image/png");
      }

      outer.addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); });
      outer.addEventListener("drop", e => { e.preventDefault(); e.stopPropagation(); handleFileList(e.dataTransfer?.files); });
      outer.addEventListener("paste", e => {
        for (const item of e.clipboardData?.items || []) {
          if (item.type.startsWith("image/")) {
            e.preventDefault(); e.stopPropagation();
            const file = item.getAsFile();
            if (file) uploadFile(file);
            break;
          }
        }
      });

      function loadCurrentImagePreview() {
        suppressBuiltInPreview();
        if (!imageWidget?.value) {
          sourceImg = null; previewImg = null; redrawPreview(); enforceNodeSize(); return;
        }
        let value = String(imageWidget.value).replaceAll("\\", "/");
        let filename = value;
        let subfolder = "";
        if (value.includes("/")) {
          const parts = value.split("/");
          filename = parts.pop();
          subfolder = parts.join("/");
        }
        const url = api.apiURL(`/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=${encodeURIComponent(subfolder)}`);
        const img = new Image();
        img.onload = () => {
          sourceImg = img;
          quarterTurns = 0; fineRotation = 0; mirrorX = false; mirrorY = false; resetReframe();
          rotationSlider.value = "0"; rotationValue.textContent = "0.0°";
          setPreviewFromSource();
          suppressBuiltInPreview();
          enforceNodeSize();
          app.graph.setDirtyCanvas(true, true);
        };
        img.onerror = () => { sourceImg = null; previewImg = null; redrawPreview(); enforceNodeSize(); };
        img.src = url;
      }

      const oldImageCallback = imageWidget?.callback;
      if (imageWidget) {
        imageWidget.callback = function () {
          oldImageCallback?.apply(this, arguments);
          suppressBuiltInPreview();
          app.graph.setDirtyCanvas(true, true);
          if (!internalImageWidgetUpdate) setTimeout(loadCurrentImagePreview, 150);
        };
      }

      function pointerIsInPreview(e) {
        const p = getCanvasPoint(e);
        return p.y >= 0 && p.y <= H;
      }

      function updateBrushCursor(e) {
        if (!pointerIsInPreview(e)) {
          pointerInPreview = false;
          brushCursorPoint = null;
        } else {
          pointerInPreview = true;
          brushCursorPoint = getCanvasPoint(e);
        }
        setWrapperCursor();
        redrawMaskOverlay();
      }

      // Handle gestures on the full preview workspace rather than only on the
      // visible image. This lets Rectangle/Lasso/Brush/Eraser begin in the
      // padded area around the image. The real mask canvas clips committed
      // pixels to valid image bounds.
      wrapper.addEventListener("pointerenter", e => {
        updateBrushCursor(e);
      }, true);

      wrapper.addEventListener("pointerleave", e => {
        if (isDrawing || isPanning) return;
        pointerInPreview = false;
        brushCursorPoint = null;
        setWrapperCursor();
        redrawMaskOverlay();
      }, true);

      wrapper.addEventListener("pointerdown", e => {
        updateBrushCursor(e);
        if (e.button !== 0 || !pointerIsInPreview(e)) { isDrawing = false; return; }
        const p = getImagePoint(e);
        if (!p) return;
        e.preventDefault(); e.stopPropagation();
        isDrawing = true;
        lastPoint = null;
        beginExplicitMask();
        selectionOperation = e.altKey ? "erase" : "paint";
        selectionStart = p;
        selectionCurrent = p;
        lassoPoints = [p];
        wrapper.setPointerCapture(e.pointerId);
        if (tool === "paint" || tool === "erase") drawBrush(e);
        else redrawMaskOverlay();
      }, true);

      wrapper.addEventListener("pointermove", e => {
        updateBrushCursor(e);
        if (!isDrawing || (e.buttons & 1) !== 1) return;
        e.preventDefault(); e.stopPropagation();
        if (tool === "paint" || tool === "erase") drawBrush(e);
        else {
          const p = getImagePoint(e);
          if (!p) return;
          selectionCurrent = p;
          if (tool === "lasso") lassoPoints.push(p);
          redrawMaskOverlay();
        }
      }, true);

      function finishPointer(e) {
        if (!isDrawing) return;
        e.preventDefault(); e.stopPropagation();
        if (tool === "rect" || tool === "lasso") applySelection();
        isDrawing = false;
        lastPoint = null;
        selectionStart = null;
        selectionCurrent = null;
        lassoPoints = [];
        try { wrapper.releasePointerCapture(e.pointerId); } catch {}
        redrawMaskOverlay();
        saveMask();
      }
      wrapper.addEventListener("pointerup", finishPointer, true);
      wrapper.addEventListener("pointercancel", finishPointer, true);
      // Pointer capture keeps move/up events flowing even beyond the padded
      // workspace and node bounds until the gesture ends.


      wrapper.addEventListener("wheel", e => {
        if (!previewImg || !pointerIsInPreview(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = maskCanvas.getBoundingClientRect();
        const cx = ((e.clientX - rect.left) / rect.width) * W;
        const cy = ((e.clientY - rect.top) / rect.height) * H;
        if (!imageRect) return;
        const outputX = ((cx - imageRect.x) / imageRect.w) * previewImg.width;
        const outputY = ((cy - imageRect.y) / imageRect.h) * previewImg.height;
        const oldZoom = zoom;

        // Fine, adaptive zoom: about 2% per normal wheel notch near 100%,
        // and slightly faster when far out or far in. Ctrl gives coarse zoom.
        let sensitivity = (zoom < 0.6 || zoom > 2.0) ? 0.0005 : 0.0002;
        if (e.ctrlKey) sensitivity *= 3;
        const factor = Math.exp(-e.deltaY * sensitivity);
        zoom = Math.min(8, Math.max(0.1, zoom * factor));

        // Keep the output point under the cursor stable while zooming.
        const centerX = previewImg.width / 2;
        const centerY = previewImg.height / 2;
        panX += (outputX - centerX - panX) * (1 - zoom / oldZoom);
        panY += (outputY - centerY - panY) * (1 - zoom / oldZoom);
        previewImg = makeTransformedImage(sourceImg);
        redrawPreview();
        scheduleTransformedImageUpload();
      }, { passive: false });

      wrapper.addEventListener("pointerdown", e => {
        if (e.button !== 1 || !pointerIsInPreview(e) || !previewImg) return;
        e.preventDefault();
        e.stopPropagation();
        isPanning = true;
        panMoved = false;
        panStart = { x: e.clientX, y: e.clientY, panX, panY };
        wrapper.setPointerCapture(e.pointerId);
        setWrapperCursor();
      }, true);

      wrapper.addEventListener("pointermove", e => {
        if (isPanning) updateBrushCursor(e);
        if (!isPanning || !panStart || !imageRect) return;
        e.preventDefault();
        e.stopPropagation();
        const scaleX = previewImg.width / imageRect.w;
        const scaleY = previewImg.height / imageRect.h;
        if (Math.hypot(e.clientX - panStart.x, e.clientY - panStart.y) > 3) panMoved = true;
        panX = panStart.panX + (e.clientX - panStart.x) * scaleX;
        panY = panStart.panY + (e.clientY - panStart.y) * scaleY;
        previewImg = makeTransformedImage(sourceImg);
        redrawPreview();
        scheduleTransformedImageUpload();
      }, true);

      function finishPan(e) {
        if (!isPanning) return;
        isPanning = false;
        panStart = null;
        setWrapperCursor();
        try { wrapper.releasePointerCapture(e.pointerId); } catch {}

        // Double middle-click returns to Fit: 100% zoom and centered.
        if (!panMoved) {
          const now = performance.now();
          if (now - lastMiddleClickTime < 350) {
            resetReframe();
            previewImg = makeTransformedImage(sourceImg);
            redrawPreview();
            scheduleTransformedImageUpload();
            lastMiddleClickTime = 0;
          } else {
            lastMiddleClickTime = now;
          }
        }
        panMoved = false;
      }
      wrapper.addEventListener("pointerup", finishPan, true);
      wrapper.addEventListener("pointercancel", finishPan, true);
      wrapper.addEventListener("auxclick", e => {
        if (e.button === 1) { e.preventDefault(); e.stopPropagation(); }
      }, true);

      wrapper.addEventListener("contextmenu", e => {
        if (!pointerIsInPreview(e)) return;
        e.preventDefault(); e.stopPropagation();
        isDrawing = false;
        const canvasEl = app.canvas?.canvas;
        if (!canvasEl) return;
        canvasEl.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true, cancelable: true, view: window,
          clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
          button: 2, buttons: 2, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
        }));
      });

      function setTool(next) { tool = next; updateButtonStyles(); redrawMaskOverlay(); }
      paintBtn.onclick = e => { e.preventDefault(); e.stopPropagation(); setTool("paint"); };
      eraseBtn.onclick = e => { e.preventDefault(); e.stopPropagation(); setTool("erase"); };
      rectBtn.onclick = e => { e.preventDefault(); e.stopPropagation(); setTool("rect"); };
      lassoBtn.onclick = e => { e.preventDefault(); e.stopPropagation(); setTool("lasso"); };
      fillBtn.onclick = e => { e.preventDefault(); e.stopPropagation(); fillRealMask(); redrawMaskOverlay(); saveMask(); markChanged(); };
      clearBtn.onclick = e => { e.preventDefault(); e.stopPropagation(); clearRealMask(); redrawMaskOverlay(); saveMask(); markChanged(); };

      rotLBtn.onclick = e => {
        e.preventDefault(); e.stopPropagation();
        quarterTurns = (quarterTurns + 3) % 4;
        fineRotation = 0; rotationSlider.value = "0"; rotationValue.textContent = "0.0°";
        resetReframe();
        setPreviewFromSource();
      };
      rotRBtn.onclick = e => {
        e.preventDefault(); e.stopPropagation();
        quarterTurns = (quarterTurns + 1) % 4;
        fineRotation = 0; rotationSlider.value = "0"; rotationValue.textContent = "0.0°";
        resetReframe();
        setPreviewFromSource();
      };
      rotationSlider.oninput = e => {
        fineRotation = Number(e.target.value);
        rotationValue.textContent = `${fineRotation.toFixed(1)}°`;
        previewImg = makeTransformedImage(sourceImg);
        setCanvasSizeFromNode();
        redrawPreview();
        saveMask();
        scheduleTransformedImageUpload();
      };
      mirrorHBtn.onclick = e => { e.preventDefault(); e.stopPropagation(); mirrorX = !mirrorX; setPreviewFromSource(); };
      mirrorVBtn.onclick = e => { e.preventDefault(); e.stopPropagation(); mirrorY = !mirrorY; setPreviewFromSource(); };
      resetBtn.onclick = e => {
        e.preventDefault(); e.stopPropagation();
        quarterTurns = 0; fineRotation = 0; mirrorX = false; mirrorY = false; resetReframe();
        rotationSlider.value = "0"; rotationValue.textContent = "0.0°";
        setPreviewFromSource();
      };
      copyBtn.onclick = e => { e.preventDefault(); e.stopPropagation(); copyPreviewImage(); };
      sizeInput.oninput = e => {
        brushSize = Number(e.target.value);
        sizeInput.title = `Brush size: ${brushSize}`;
        localStorage.setItem(BRUSH_STORAGE_KEY, String(brushSize));
        redrawMaskOverlay();
      };

      updateButtonStyles();
      markChanged();
      suppressBuiltInPreview();
      node.setSize([Math.max(node.size?.[0] || minNodeW, minNodeW), Math.max(node.size?.[1] || minNodeH(), minNodeH())]);
      setCanvasSizeFromNode();
      redrawPreview();
      setTimeout(() => { suppressBuiltInPreview(); loadCurrentImagePreview(); app.graph.setDirtyCanvas(true, true); }, 300);

      node.onResize = function (size) {
        onResize?.apply(this, arguments);
        if (resizing) return;
        if (size[0] < minNodeW) size[0] = node.size[0] = minNodeW;
        if (size[1] < minNodeH()) size[1] = node.size[1] = minNodeH();
        setCanvasSizeFromNode();
        app.graph.setDirtyCanvas(true, true);
      };
    };
  },
});

