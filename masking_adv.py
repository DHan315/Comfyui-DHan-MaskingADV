import base64
import io
import os

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths


def get_input_images():
    input_dir = folder_paths.get_input_directory()
    files = []

    valid_exts = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

    for root, _, filenames in os.walk(input_dir):
        for filename in filenames:
            ext = os.path.splitext(filename)[1].lower()
            if ext in valid_exts:
                full_path = os.path.join(root, filename)
                rel_path = os.path.relpath(full_path, input_dir)
                files.append(rel_path.replace("\\", "/"))

    return sorted(files)


class MaskingADV:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    get_input_images(),
                    {"image_upload": True},
                ),
                "mask_data": ("STRING", {"default": "", "multiline": False}),
            }
        }

    CATEGORY = "Comfyui-DHan/MaskingADV"
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "load_image_and_mask"

    def load_image_and_mask(self, image, mask_data):
        image_path = folder_paths.get_annotated_filepath(image)

        img = Image.open(image_path)
        img = ImageOps.exif_transpose(img).convert("RGB")

        img_np = np.asarray(img).astype(np.float32) / 255.0
        img_tensor = torch.from_numpy(img_np)[None,]

        h, w = img_np.shape[:2]

        if not mask_data:
            # No explicit user mask means the full image is active. The
            # frontend keeps this implicit mask invisible until the user edits it.
            mask = torch.ones((1, h, w), dtype=torch.float32)
            return (img_tensor, mask)

        if "," in mask_data:
            mask_data = mask_data.split(",", 1)[1]

        raw = base64.b64decode(mask_data)
        mask_img = Image.open(io.BytesIO(raw)).convert("L")
        mask_img = mask_img.resize((w, h), Image.Resampling.LANCZOS)

        mask_np = np.asarray(mask_img).astype(np.float32) / 255.0
        mask_tensor = torch.from_numpy(mask_np)[None,]

        return (img_tensor, mask_tensor)

    @classmethod
    def IS_CHANGED(cls, image, mask_data):
        return image + str(hash(mask_data))

