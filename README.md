# TaiKeHoaDon

Tải hóa đơn điện tử từ **hoadondientu.gdt.gov.vn** (mua vào và bán ra) và xuất **bảng kê Excel theo tháng**,
có kiểm tra trạng thái hóa đơn, tổng hợp thuế suất và cảnh báo.

Tool không lưu mật khẩu, không vượt captcha: bạn tự đăng nhập trong cửa sổ trình duyệt do tool mở;
tool chỉ lặp lại thao tác bạn vẫn làm bằng tay (tìm kiếm → chọn hóa đơn → **Xuất xml**).

## Cài đặt

Cần Node.js 18+ và Microsoft Edge (hoặc Google Chrome). Bấm đúp **`TaiKeHoaDon.bat`** —
lần đầu tool tự cài thư viện (`npm install`).

## Menu

| Chọn | Việc |
|---|---|
| 1 | **Tải tự động**: nhập khoảng ngày + loại hóa đơn, tool tự tìm kiếm và tải hết |
| 2 | **Tải thủ công**: bạn tự tìm kiếm trên trang, nhấn Enter để tool tải danh sách đang hiện |
| 3 | Xuất bảng kê Excel từ các hóa đơn đã tải |
| 4 | Chia file XML/zip tải tay vào đúng thư mục mua vào / bán ra |
| 5, 6 | Mở thư mục kết quả / nhật ký |

### Tải tự động

1. Chọn **1** → cửa sổ Edge mở ra → **đăng nhập** cổng thuế (tự gõ captcha).
2. Quay lại cửa sổ đen: nhập *Từ ngày*, *Đến ngày* (dd/mm/yyyy) và loại (mua vào / bán ra / cả hai).
3. Tool tự mở **Tra cứu hóa đơn**, chia khoảng ngày theo tháng (tối đa 30 ngày/lần) và tìm lần lượt:
   - Mua vào: *Đã cấp mã hóa đơn*, *Cục Thuế đã nhận không mã*, *Có mã khởi tạo từ máy tính tiền*
   - Bán ra: *Tất cả*
   - ở cả 2 tab con *Hóa đơn điện tử* và *Hóa đơn có mã khởi tạo từ máy tính tiền*, 50 dòng/trang.
4. Xong thì tool tự xuất bảng kê.

Hóa đơn đã tải sẽ được bỏ qua; hóa đơn lỗi (cổng thuế quá tải, "Cassandra timeout"…) được bỏ qua và
liệt kê cuối lượt — **chạy lại cùng khoảng ngày để tải bù**. Nếu trang thuế đổi giao diện làm chế độ
tự động không chạy được, dùng chế độ thủ công.

## Thư mục

| Thư mục | Nội dung |
|---|---|
| `input/mua-vao`, `input/ban-ra` | File hóa đơn tải về: `MSTngườibán_KýhiệuMẫusốKýhiệu_Số.zip` |
| `input/*/_trang_thai.json` | Trạng thái hóa đơn đọc từ bảng tra cứu (hủy, thay thế, điều chỉnh, bất hợp pháp) |
| `input/*/_so_luong.json` | Số kết quả cổng thuế báo cho mỗi lần tìm (để đối chiếu) |
| `ket_qua/` | Bảng kê: `bang_ke_mua_ban_T09-2026_<ngày>_<giờ>.xlsx` |
| `logs/` | Nhật ký mỗi lần chạy |
| `mau/bang_ke_mau.xlsx` | Mẫu định dạng bảng kê (đặt file mẫu riêng vào `hoadon/bang_ke_mua_ban.xlsx` để dùng thay) |

## Bảng kê (mỗi tháng 1 file, theo ngày lập)

| Sheet | Nội dung |
|---|---|
| `T09` (tháng) và `Total` | Hóa đơn mua vào của tháng, mỗi dòng hàng hóa 1 dòng |
| `Bán ra` | Hóa đơn bán ra của tháng (giữ công thức cột M, Q, R như mẫu) |
| `Kiểm tra` | Đối chiếu số lượng, tổng hợp theo thuế suất, cảnh báo |

- Cột **Trạng thái HĐ** (mua vào: cột P, bán ra: cột S). Hóa đơn **đã bị hủy / đã bị thay thế** tô đỏ và
  **không cộng** vào dòng TỔNG CỘNG (công thức `SUMIFS`); hóa đơn điều chỉnh tô vàng; "Bất hợp pháp" tô đỏ.
- Chạy lại: mở file mới nhất của tháng đó, chỉ thêm hóa đơn chưa có và cập nhật trạng thái, lưu thành
  file mới. Tháng không có gì thay đổi thì không tạo file. Chỉnh sửa tay trong file được giữ lại.

### Sheet Kiểm tra

1. **Số lượng**: cổng thuế báo / đã có file / chưa tải được (chỉ có số cổng thuế khi tải tự động).
2. **Tổng hợp theo thuế suất** (0%, 5%, 8%, 10%, KCT…): tiền hàng, tiền thuế mua vào và bán ra —
   không tính hóa đơn đã hủy / bị thay thế — để đối chiếu với tờ khai 01/GTGT.
3. **Cảnh báo**: hóa đơn hủy / thay thế / điều chỉnh, hóa đơn bị đánh dấu *Bất hợp pháp*, hóa đơn mua vào
   từ **5 triệu đồng** thanh toán tiền mặt (Luật Thuế GTGT 2024 — đổi `CASH_LIMIT` trong `lib/bangke.js`
   nếu quy định thay đổi), hóa đơn có trên cổng thuế nhưng chưa tải được.

## Code

| File | Việc |
|---|---|
| `download.js` | Mở trình duyệt, chế độ tự động / thủ công, rồi xuất bảng kê |
| `lib/auto.js` | Tự chọn tab, nhập ngày, chọn "Kết quả kiểm tra", Tìm kiếm, 50 dòng/trang |
| `lib/portal.js` | Thao tác trên bảng: chọn dòng, Xuất xml, chuyển trang, nhận file về muộn |
| `lib/reader.js` | Đọc XML hóa đơn (chuẩn TT78) từ .xml / .zip |
| `lib/status.js` | Lưu / tra trạng thái hóa đơn |
| `lib/bangke.js`, `bang-ke.js` | Xuất bảng kê theo mẫu + sheet Kiểm tra |
| `sap-xep.js` | Chia file tải tay vào `mua-vao` / `ban-ra` |
