# Buzz-Buster Extension

Buzz-Buster là Chrome/Brave Extension giải trí: sau một khoảng thời gian ngẫu nhiên, một con muỗi nhỏ xuất hiện trên website, phát tiếng vo ve và bay quanh màn hình. Người dùng phải bấm nút chọn vợt để đổi cursor thành vợt rồi mới đập muỗi.

## MVP hiện tại

- Popup cho phép bật/tắt Buzz-Buster Mode.
- Popup cho phép cấu hình `minDelay` và `maxDelay` theo giây.
- Khi chưa có muỗi, website hoạt động bình thường: không đổi cursor, không hiện overlay phụ.
- Khi muỗi xuất hiện, extension phát `assets/mosquito-buzz.mp3`.
- Khi muỗi xuất hiện, trang hiển thị prompt chọn vợt.
- Sau khi chọn vợt, cursor đổi sang `assets/racket-cursor.png`.
- Click trượt khi đã chọn vợt phát `assets/slap.mp3`.
- Click trúng muỗi khi đã chọn vợt phát `assets/slap-ahh.mp3`.
- Khi đập trúng, muỗi biến mất, tiếng vo ve dừng, cursor trở lại bình thường.
- Kill counter chỉ hiển thị trong popup extension.
- Không hiển thị kill counter trực tiếp trên website.

## Cấu trúc dự án

```text
.
|-- manifest.json
|-- popup.html
|-- popup.css
|-- popup.js
|-- content.js
|-- assets/
|   |-- icon-16.png
|   |-- icon-32.png
|   |-- icon-48.png
|   |-- icon-128.png
|   |-- mosquito.png
|   |-- racket-cursor.png
|   |-- mosquito-buzz.mp3
|   |-- slap.mp3
|   `-- slap-ahh.mp3
`-- README.md
```

## Dữ liệu lưu trong `chrome.storage.local`

```json
{
  "buzzBusterEnabled": true,
  "minDelay": 30,
  "maxDelay": 120,
  "killedCount": 7
}
```

## Luồng hoạt động

```text
User bật Buzz-Buster Mode
        |
Extension lưu settings
        |
Content script đặt timer random
        |
Muỗi xuất hiện và phát tiếng buzz
        |
User bấm Equip racket
        |
Cursor đổi thành vợt
        |
Click trượt: phát slap.mp3
Click trúng: phát slap-ahh.mp3, tăng killedCount, xóa muỗi, dừng buzz
        |
Extension đặt timer random cho lần tiếp theo
```

## Quyền extension

- `storage`: lưu trạng thái bật/tắt và delay.
- `activeTab`: thao tác với tab hiện tại khi người dùng bấm popup.
- `scripting`: inject content script khi tab hiện tại chưa có content script.

## Tiêu chí hoàn thành

- Extension load được trên Chrome/Brave.
- Popup Start/Stop hoạt động đúng.
- Delay được validate: min từ 5 giây, max lớn hơn min, max không quá 7200 giây.
- Muỗi nhỏ xuất hiện sau delay random.
- Prompt vợt chỉ xuất hiện khi có muỗi.
- Cursor chỉ đổi thành vợt sau khi user bấm Equip racket.
- Miss phát `slap.mp3`.
- Hit phát `slap-ahh.mp3`.
- Kill counter hiển thị trong popup.
- Không có UI kill counter trên website.
- Không tạo nhiều timer, nhiều muỗi hoặc nhiều listener trùng nhau.
