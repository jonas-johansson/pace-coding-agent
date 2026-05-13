# Image input handling: Anthropic vs. OpenAI

Research date: 2026-05-13

## Scope

This note summarizes how Anthropic and OpenAI handle user-supplied images in their developer-facing APIs: how images can be sent, accepted formats and limits, preprocessing/tokenization, safety filtering, retention/training posture, and known limitations. It focuses on official documentation where possible.

## Executive summary

| Area | Anthropic / Claude | OpenAI |
|---|---|---|
| Primary image-understanding endpoints | Claude Messages API, claude.ai, Console Workbench | Responses API, Chat Completions API; Images API for generation/editing with image inputs |
| Ways to send images | Base64 image block, URL image block, or Files API `file_id` | Image URL, Base64 data URL, or Files API `file_id` |
| Supported formats | JPEG, PNG, GIF, WebP; animated GIFs use first frame only | PNG, JPEG/JPG, WebP, non-animated GIF |
| API image count/size limits | Up to 600 images/request, or 100 for models with 200k-token context; 5 MB/image; 32 MB standard request limit; max 8000 x 8000 px, reduced to 2000 x 2000 px when sending >20 images | Up to 1500 image inputs/request; up to 512 MB total payload/request for image inputs |
| Preprocessing | Images count as tokens; large images are resized/padded; metadata is not parsed or received | Images count as tokens; detail levels (`low`, `high`, `original`, `auto`) influence resizing/token costs; original filenames/metadata are not processed |
| Storage/retention | Inline image uploads are described as ephemeral and deleted after processing; Files API uploads persist until deleted and are not ZDR-eligible; standard commercial/API inputs and outputs generally deleted within 30 days unless exceptions apply | API data not used for training by default; abuse monitoring logs generally retained up to 30 days; `/v1/files` application state persists until deleted or expiry; image/file inputs are CSAM-scanned and retained for manual review if flagged |
| Safety / prohibited content | Refuses person identification; does not process inappropriate/explicit images violating AUP; not for diagnostic medical imaging | Requires no NSFW content; blocks CAPTCHAs; image/file inputs scanned for CSAM; not for medical advice/specialized medical image interpretation |

## Anthropic / Claude

### How users can send images

Anthropic supports vision through:

- **claude.ai**: users upload an image like a file or drag and drop it into chat.
- **Console Workbench**: user message blocks can include images.
- **API**: images can be sent in Claude Messages API content blocks.

For the API, Anthropic documents three input methods:

1. **Base64-encoded image** in an `image` content block.
2. **URL image source** using `source.type: "url"`.
3. **Files API** upload once, then reference by `file_id` in an `image` content block.

Anthropic recommends putting images before the text question/instruction where possible, and labeling multiple images (for example, “Image 1,” “Image 2”) when comparing them.

Sources: Anthropic Vision docs; Anthropic Files API docs.

### Supported formats and limits

Anthropic lists supported MIME types:

- `image/jpeg`
- `image/png`
- `image/gif`
- `image/webp`

Animated images are not supported as animations; only the first frame is used.

Key limits:

- **File size**:
  - API: 5 MB per image.
  - claude.ai: 10 MB per image.
- **Image count**:
  - claude.ai: 20 images per turn/message.
  - API: up to 600 images per request generally.
  - API: up to 100 images per request for models with a 200k-token context window.
- **Dimensions**:
  - Max 8000 x 8000 px per image.
  - If submitting more than 20 images in one API request, max dimensions are reduced to 2000 x 2000 px.
- **Request size**:
  - Standard endpoints have a 32 MB request size limit, which can be reached before image-count limits.

### Preprocessing, tokenization, and cost

Anthropic states that each image counts toward token usage. Its approximation is:

```text
image tokens ≈ width * height / 750
```

Large images may be resized before processing. Anthropic currently documents:

- Claude Opus 4.7: up to about 4784 tokens and at most 2576 px on the long edge.
- Other models: up to about 1568 tokens and at most 1568 px on the long edge.

Images are also padded on the bottom/right to a multiple of 28 pixels. For coordinate-return workflows, Anthropic warns that coordinates refer to the resized/padded image and must be rescaled/transformed client-side.

Anthropic explicitly says Claude does **not** parse or receive image metadata.

### Files API behavior for images

The Files API supports images (`image/jpeg`, `image/png`, `image/gif`, `image/webp`) as `image` content blocks. It is intended for images reused across multiple requests, especially multi-turn conversations where resending Base64 bytes would increase payload size and latency.

Important lifecycle/retention details:

- Files API is beta and requires a beta header.
- It is **not eligible for Zero Data Retention (ZDR)**.
- Uploaded files are scoped to the workspace.
- Files persist until explicitly deleted.
- Maximum file size: 500 MB per file.
- Total storage: 500 GB per organization.

### Retention and training posture

Anthropic’s Vision FAQ says:

- Image uploads are ephemeral and not stored beyond the duration of the API request.
- Uploaded images are automatically deleted after processing.
- Anthropic does not use uploaded images to train models.

The broader Anthropic commercial/API retention help article says API inputs and outputs are automatically deleted on the backend within 30 days, except when a longer-retention service such as the Files API is used, when a different agreement exists (such as ZDR), for usage-policy enforcement, or legal compliance. It also says usage-policy-flagged inputs/outputs may be retained up to 2 years, with trust/safety classification scores up to 7 years.

Practical interpretation: inline image upload handling is described in the Vision docs as ephemeral/deleted after processing, while uploaded Files API assets are intentionally persistent until deleted and subject to standard Files API retention. Broader request data/outputs may still be subject to Anthropic’s commercial/API retention framework and exceptions.

### Safety and limitations

Anthropic documents several important limitations and safety behaviors:

- Claude cannot be used to identify/name people in images and refuses such requests.
- It may make mistakes with low-quality, rotated, or very small images.
- Spatial reasoning and precise localization can be limited.
- Counting is approximate.
- Claude should not be relied on to detect AI-generated images.
- Claude does not process inappropriate/explicit images that violate Anthropic’s Acceptable Use Policy.
- Claude is not a substitute for professional medical advice/diagnosis and is not designed to interpret complex diagnostic scans such as CTs or MRIs.
- Claude can analyze/understand images but does not generate, edit, manipulate, or create images.

## OpenAI

### How users can send images

OpenAI documents image inputs across multiple APIs:

- **Responses API**: analyze images and use them as inputs; can also use image-generation tools.
- **Chat Completions API**: analyze images as inputs to generate text or audio.
- **Images API**: generate or edit images, optionally using images as inputs.

OpenAI supports multiple image input methods:

1. **Fully qualified URL** to an image file.
2. **Base64-encoded data URL** (for example, `data:image/jpeg;base64,...`).
3. **Files API `file_id`**, after uploading with a purpose such as `vision` for image inputs or `user_data` for general model file inputs.

In the Responses API, image parts use `type: "input_image"`. In Chat Completions, image parts commonly use `type: "image_url"` with either a URL or Base64 data URL.

### Supported formats and limits

OpenAI image-input requirements include:

- PNG (`.png`)
- JPEG/JPG (`.jpeg`, `.jpg`)
- WebP (`.webp`)
- Non-animated GIF (`.gif`)

OpenAI states the following image input limits:

- Up to **512 MB total payload size per request**.
- Up to **1500 individual image inputs per request**.

Other requirements:

- No watermarks or logos.
- No NSFW content.
- Image must be clear enough for a human to understand.

### Preprocessing, detail levels, tokenization, and cost

OpenAI image inputs count as tokens and are billed accordingly. It exposes a `detail` parameter controlling how much visual detail the model uses:

- `low`: fast/low-cost; model receives a low-resolution 512 x 512 version.
- `high`: standard high-fidelity understanding.
- `original`: for large, dense, spatially sensitive, or computer-use images on supported models.
- `auto`: model/platform decides; defaults vary by model family.

OpenAI documents model-specific resizing and tokenization. Examples:

- Some GPT-5.5/GPT-5.4 models use patch-based image tokenization with 32 x 32 px patches and patch budgets.
- GPT-4o/GPT-4.1/GPT-4o-mini and some o-series models use tile-based resizing/tokenization, where `low` has a fixed base token cost and `high` uses 512 px tiles after resizing.

OpenAI says models do **not** process original file names or metadata. Depending on image size/detail level, images may be resized before analysis, affecting original dimensions.

### File inputs and PDFs with images

OpenAI distinguishes direct image inputs from broader file inputs:

- `input_file` can be sent as Base64 data, a Files API file ID, or an external URL in the Responses API.
- For PDFs on vision-capable models, OpenAI extracts both text and page images and sends both to the model.
- For non-PDF document/text files such as `.docx`, `.pptx`, `.txt`, and code files, OpenAI extracts text only.
- For non-PDF files, embedded images/charts are not extracted into model context; OpenAI recommends converting to PDF to preserve chart/diagram fidelity.
- For file inputs, OpenAI documents a per-file limit under 50 MB and 50 MB combined across all files in a request.

### Retention and training posture

OpenAI’s data controls page states:

- Data sent to the OpenAI API is **not used to train or improve OpenAI models** unless the customer explicitly opts in.
- Abuse monitoring logs may contain customer content and are generally retained up to 30 days by default, unless longer retention is required by law or to protect services/third parties.
- Eligible customers can apply for Modified Abuse Monitoring or Zero Data Retention.
- `/v1/chat/completions` and `/v1/responses` are listed as not used for training, with 30-day abuse monitoring retention and no application-state retention by default, subject to exceptions.
- `/v1/files` is not used for training, has 30-day abuse monitoring retention, and application-state retention until deleted. Files can be manually deleted or automatically deleted using `expires_after`.

Important image/file-specific safety retention rule:

- Images and files submitted to `/v1/responses`, `/v1/chat/completions`, and `/v1/images` are scanned for CSAM on submission.
- If a classifier detects potential CSAM, the image is retained for manual review even if Zero Data Retention or Modified Abuse Monitoring is enabled.

For OpenAI image generation endpoints:

- `/v1/images/generations`, `/v1/images/edits`, and `/v1/images/variations` are not used for training and have 30-day abuse monitoring retention with no application-state retention, with ZDR support depending on model.

### Safety and limitations

OpenAI documents these vision limitations and safety behaviors:

- Not suitable for interpreting specialized medical images such as CT scans and should not be used for medical advice.
- May underperform on non-Latin text in images.
- Small, rotated, or upside-down text/images can be misinterpreted.
- Graphs and visual elements with style/color variation can be difficult.
- Spatial localization can be imprecise.
- Descriptions/captions may be incorrect.
- Panoramic/fisheye images can be challenging.
- Counting may be approximate.
- CAPTCHAs are blocked for safety reasons.
- Image input requirements disallow NSFW content.

## Notable similarities

- Both vendors support URL-based, Base64-based, and uploaded-file-ID image workflows.
- Both support JPEG, PNG, WebP, and GIF in a limited/non-animated fashion.
- Both meter images as tokens and may resize images before analysis.
- Both say image metadata/original filenames are not processed by the model.
- Both warn against high-stakes reliance without human review, especially medical and precise spatial/localization use cases.
- Both say API customer data is not used for training by default / uploaded images are not used for training, subject to opt-in or special programs.
- Both have separate persistent file-upload mechanisms where files can be reused across requests and must be deleted/expired to remove stored file state.

## Notable differences

- **Limits**: Anthropic has a stricter per-image API size limit (5 MB/image) and request-size limit (32 MB standard endpoint), while OpenAI documents much larger aggregate image-input payload capacity (512 MB/request) and more individual image inputs (1500/request).
- **Detail control**: OpenAI exposes explicit `detail` settings (`low`, `high`, `original`, `auto`) that control fidelity/cost tradeoffs. Anthropic documents automatic resizing/native resolution behavior and recommends client-side resizing when appropriate.
- **Retention wording**: Anthropic’s Vision FAQ specifically describes inline image uploads as ephemeral and deleted after processing, while its Files API persists files until deleted. OpenAI describes API-wide retention via abuse logs/application state and explicitly calls out CSAM scanning/retention for image and file inputs.
- **Capabilities**: Claude is image-understanding only and cannot generate/edit images. OpenAI supports both image understanding and image generation/editing through image-capable models and APIs.

## Sources

- Anthropic, “Vision - Claude API Docs”: https://docs.anthropic.com/en/docs/build-with-claude/vision
- Anthropic, “Files API - Claude API Docs”: https://console.anthropic.com/docs/en/build-with-claude/files
- Anthropic Help Center, “How long do you store my organization’s data?”: https://support.anthropic.com/en/articles/7996866-how-long-does-anthropic-store-data
- OpenAI, “Images and vision - OpenAI API”: https://developers.openai.com/api/docs/guides/images-vision
- OpenAI, “File inputs - OpenAI API”: https://developers.openai.com/api/docs/guides/file-inputs
- OpenAI, “Data controls in the OpenAI platform”: https://developers.openai.com/api/docs/guides/your-data
