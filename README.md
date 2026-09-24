# Comfyui-DHan-MaskingADV

Advanced image masking and editing inside a ComfyUI node. MaskingADV lets you load, paste, or drop an image, transform it, and paint a mask without opening a separate editor. It outputs the edited image and mask for downstream nodes.

The frontend includes Nodes 2.0 preview compatibility and brush cursor updates.

## Features

- Image loading, paste, and drag-and-drop
- Brush painting and erasing, rectangle and lasso masking, fill and clear
- Rotation, mirroring, zoom, and pan
- Image and mask outputs

## Installation

Search for **Comfyui-DHan-MaskingADV** in ComfyUI Manager, or clone [this repository](https://github.com/DHan315/Comfyui-DHan-MaskingADV) into `ComfyUI/custom_nodes/`. Restart ComfyUI and refresh the browser after updating.

The node appears as **DHan-MaskingADV** under `Comfyui-DHan/MaskingADV`.

The internal node ID is `MaskingADV`. Existing workflows using the old node ID must replace the node or update their saved workflow JSON.

