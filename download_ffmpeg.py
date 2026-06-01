import urllib.request
import tarfile
import os

url = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
tar_path = "ffmpeg.tar.xz"
dest_dir = "layers/ffmpeg/bin"

# Create destination directory if not exists
os.makedirs(dest_dir, exist_ok=True)

print("Downloading FFmpeg static build...")
urllib.request.urlretrieve(url, tar_path)

print("Extracting tar.xz...")
with tarfile.open(tar_path, "r:xz") as tar:
    for member in tar.getmembers():
        if member.name.endswith("/ffmpeg") and not member.name.endswith("/ffmpeg-10bit"):
            # We want to extract it directly into layers/ffmpeg/bin as 'ffmpeg'
            member_file = tar.extractfile(member)
            if member_file:
                ffmpeg_path = os.path.join(dest_dir, "ffmpeg")
                with open(ffmpeg_path, "wb") as f:
                    f.write(member_file.read())
                break

print("Changing permissions...")
ffmpeg_binary_path = os.path.join(dest_dir, "ffmpeg")
os.chmod(ffmpeg_binary_path, 0o755)
print(f"FFmpeg successfully placed at {ffmpeg_binary_path}")

# Clean up
if os.path.exists(tar_path):
    os.remove(tar_path)
