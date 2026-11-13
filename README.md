# Voice AI Hologram — bản nâng cấp

Ứng dụng web Hologram dùng Gemini Live để hội thoại bằng giọng nói thời gian thực. Giao diện vẫn giữ bố cục ngang: quả cầu xuất hiện lúc chờ; khi có hội thoại thì quả cầu thu/ẩn và phần chữ xuất hiện; khi tìm video, lớp YouTube phủ lên phần nội dung chính và phụ đề nằm ở đáy video.

## Điểm đã nâng cấp

- Dùng model Live được Google liệt kê hiện hành: `gemini-3.8-live`.
- Dùng `@google/genai` SDK thay cho việc tự ghép WebSocket JSON thủ công.
- Backend cấp ephemeral token ngắn hạn. Gemini API key gốc không được gửi xuống trình duyệt, không nằm trong HTML, JavaScript hoặc `localStorage`.
- Thay `ScriptProcessorNode` đã lỗi thời bằng `AudioWorklet`; âm thanh microphone được chuyển về PCM 16 kHz trước khi gửi đến Gemini.
- Âm thanh trả về được phát theo hàng đợi PCM 24 kHz; xử lý ngắt lời và xóa âm thanh còn đang chờ.
- Bỏ Web Speech API chạy song song để tránh hai bộ nhận diện cùng giành trạng thái microphone.
- Chờ Live session được SDK thiết lập trước khi gửi âm thanh; không dùng thời gian chờ cố định 1 giây.
- Microphone được giữ độc lập với trạng thái AI đang nói, nhờ đó có thể nói chen để Gemini Live xử lý barge-in.
- Sửa vòng đời stream microphone, kết nối lại, lỗi quyền microphone, resize canvas/DPR, YouTube Player API và các trạng thái UI.
- YouTube Data API key cũng chỉ nằm ở backend `.env`; tìm video qua câu lệnh nói như “mở video về văn hóa Jrai”.
- Có giới hạn tốc độ cơ bản cho endpoint cấp token và tìm video.

## Yêu cầu

- Node.js 22.12 trở lên.
- Trình duyệt hiện đại có hỗ trợ `getUserMedia`, `AudioWorklet` và WebSocket.
- Gemini API key có quyền dùng Gemini Live API.
- YouTube Data API v3 key chỉ cần khi dùng tính năng tìm video.

## Cài đặt trên Windows

1. Giải nén thư mục dự án.
2. Mở Terminal/CMD tại thư mục `hologram-ai-modern`.
3. Cài thư viện:

   ```bash
   npm install
   ```

4. Tạo file cấu hình môi trường:

   PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

   CMD:

   ```cmd
   copy .env.example .env
   ```

5. Mở `.env` và điền khóa API ở máy của bạn:

   ```env
   GEMINI_API_KEY=YOUR_NEW_GEMINI_API_KEY
   GEMINI_LIVE_MODEL=gemini-3.8-live
   YOUTUBE_API_KEY=YOUR_YOUTUBE_DATA_API_KEY
   PORT=8080
   API_PORT=8787
   ```

   `YOUTUBE_API_KEY` có thể để trống nếu chưa cần tìm video.

6. Chạy chế độ phát triển:

   ```bash
   npm run dev
   ```

7. Mở địa chỉ Vite hiển thị trong Terminal, thường là `http://localhost:5173`.
8. Xoay màn hình ngang, nhấn nút microphone và cấp quyền microphone.

## Chạy bản production

```bash
npm run build
npm start
```

Mở `http://localhost:8080` (hoặc cổng bạn đặt trong `.env`).

## Lưu ý quan trọng

- Không mở `index.html` bằng cách nhấp đúp (`file://`). Hãy chạy qua máy chủ như hướng dẫn.
- Microphone trên thiết bị khác localhost cần HTTPS. Khi triển khai công khai, hãy dùng HTTPS.
- Không dán API key vào cuộc trò chuyện, ảnh chụp màn hình hoặc mã frontend. Khóa đã từng được chia sẻ công khai nên cần thu hồi và tạo khóa mới trước khi cấu hình.
- Không đưa file `.env` lên GitHub hoặc gửi cho người khác. `.gitignore` đã bỏ qua file này.
- Ephemeral token có thời hạn ngắn. Ứng dụng xin token mới khi tạo phiên Live mới.
- Autoplay YouTube có thể bị trình duyệt chặn; trong trường hợp đó hãy nhấn nút phát trên trình phát. Một số video không cho phép nhúng nên sẽ không phát được.
- Tên model, quyền truy cập và hạn mức có thể phụ thuộc tài khoản/dự án Google AI. Nếu Google trả lỗi model hoặc quota, kiểm tra Google AI Studio và cập nhật `GEMINI_LIVE_MODEL` trong `.env` theo model Live được bật cho dự án.

## Kiến trúc

```text
Browser (Vite / production static)
  ├─ AudioWorklet → PCM 16 kHz → Gemini Live WebSocket (ephemeral token)
  ├─ PCM 24 kHz ← Gemini Live → Web Audio playback queue
  └─ voice command → /api/youtube-search → YouTube Data API v3

Node.js backend
  ├─ GEMINI_API_KEY → tạo ephemeral token cho một phiên Live
  └─ YOUTUBE_API_KEY → tìm video; khóa không gửi về trình duyệt
```
