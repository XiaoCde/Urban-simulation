# -*-coding:utf-8 -*-
# python3.9
# 绘制中国地图，高亮21个城市

"""
# @File       : 2_ChinaMap.py
# @software   : PyCharm  
# @Time       ：2024/6/22 23:05
# @Author     ：Wei Lyu
"""


import cartopy.io.shapereader as shpreader
import cartopy.crs as ccrs
import cartopy.feature as cfeat
from cartopy.io.shapereader import Reader
import matplotlib.pyplot as plt
import matplotlib.image as mpimg
import pandas as pd



plt.rcParams['pdf.fonttype'] = 42

if __name__ == '__main__':

    file = r'D:\LW\ABM\OutputData\cities_21\cities21_pop_CH.csv'
    cities = pd.read_csv(file, header=None, usecols=[3, 4, 5], encoding='gbk')

    shp_path = r'D:\LW\ABM\Data\cities_92\mapping'

    # --创建画图空间
    proj = ccrs.PlateCarree()  # 创建坐标系
    fig = plt.figure(figsize=(9, 10), dpi=350)  # 创建页面
    ax = fig.subplots(1, 1, subplot_kw={'projection': proj})  # 创建子图

    # 设置范围
    extent = [100, 132, 17, 50]
    ax.set_extent(extent, crs=proj)

    # --增加高分辨率地形图（需自行下载）
    fname = shp_path + r'\NE1_LR_LC_SR_W\NE1_LR_LC_SR_W.tif'
    ax.imshow(mpimg.imread(fname), origin='upper', transform=proj, extent=[-180, 180, -90, 90])

    # --设置网格点属性
    gl = ax.gridlines(crs=ccrs.PlateCarree(), draw_labels=True, linewidth=0.6, color='k', alpha=0.5, linestyle='--')
    gl.xlabels_top = False  # 关闭顶端的经纬度标签
    gl.ylabels_right = False  # 关闭右侧的经纬度标签
    # gl.xformatter = LONGITUDE_FORMATTER  # x轴设为经度的格式
    # gl.yformatter = LATITUDE_FORMATTER  # y轴设为纬度的格式
    # # 设置经纬度网格的间隔
    # gl.xlocator = mticker.FixedLocator(np.arange(extent[0], extent[1] + 10, 6))
    # gl.ylocator = mticker.FixedLocator(np.arange(extent[2], extent[3] + 10, 6))
    gl.xlabel_style = {'size': 12}
    gl.ylabel_style = {'size': 12}

    # 添加省界
    # shapefile = shp_path + r'\ne_10m_admin_1_states_provinces\ne_10m_admin_1_states_provinces.shp'
    # reader = shpreader.Reader(shapefile)
    # provinces = cfeature.ShapelyFeature(reader.geometries(), ccrs.PlateCarree(), edgecolor='gray')
    # ax.add_feature(provinces, linestyle='--', facecolor='none', edgecolor='gray', linewidth=0.1)

    # 添加省界(标准)
    shapefile = shp_path + r'\中国标准行政区划数据GS（2024）0650号\中国标准行政区划数据GS（2024）0650号\shp格式\中国_市.shp'
    reader = shpreader.Reader(shapefile)
    cities_std = cfeat.ShapelyFeature(reader.geometries(), ccrs.PlateCarree())
    ax.add_feature(cities_std, facecolor='none', edgecolor='k', linewidth=0.8, alpha=0.4)

    # 添加21个城市
    reader = Reader(r'D:\LW\ABM\OutputData\cities_21\cities_21.shp')
    cities_map = cfeat.ShapelyFeature(reader.geometries(), proj, edgecolor='k', facecolor='none')
    ax.add_feature(cities_map, facecolor='#f6d8c2', edgecolor='#d22225', alpha=0.9, linewidth=0.8)

    # 添加10段线
    shapefile = shp_path + r'\中国标准行政区划数据GS（2024）0650号\中国标准行政区划数据GS（2024）0650号\shp格式\中国_省line.shp'
    reader = shpreader.Reader(shapefile)
    nanhai = cfeat.ShapelyFeature(reader.geometries(), ccrs.PlateCarree())
    ax.add_feature(nanhai, facecolor='none', edgecolor='k', linewidth=2, alpha=0.7)

    # 添加主体轮廓线-手动删除了部分岛屿，因为市一级已经包括了
    outline_shp = shp_path + r'\国界线\主体轮廓线.shp'
    reader = shpreader.Reader(outline_shp)
    outline = cfeat.ShapelyFeature(reader.geometries(), ccrs.PlateCarree(), edgecolor='#D3D5EB', facecolor='#BBB2D7')
    ax.add_feature(outline, facecolor='none', edgecolor='#505050', alpha=0.7, linewidth=2)


    # 南海数据框
    sub_ax = fig.add_axes([0.68, 0.13, 0.22, 0.27], projection=ccrs.PlateCarree())
    sub_ax.set_extent([105, 125, 0.5, 25.5])
    sub_ax.imshow(mpimg.imread(fname), origin='upper', transform=proj, extent=[-180, 180, -90, 90])
    sub_ax.add_feature(cities_std, facecolor='none', edgecolor='k', linewidth=0.8, alpha=0.4)
    sub_ax.add_feature(nanhai, facecolor='none', edgecolor='k', linewidth=2, alpha=0.7)
    sub_ax.add_feature(outline, facecolor='none', edgecolor='#505050', alpha=0.7, linewidth=2)

    # 添加河流、湖泊
    # sub_ax.add_feature(cfeature.RIVERS.with_scale('10m'), lw=0.25)
    # sub_ax.add_feature(cfeature.LAKES.with_scale('10m'))

    for i, r in cities.iterrows():
        city = r[3].capitalize()
        lon = r[4]
        lat = r[5]
        if city == 'Guangzhoushi':
            ax.text(lon-1, lat+0.5, city[:-3], color='k', fontsize=12, transform=ccrs.PlateCarree(),
                    bbox=dict(facecolor='white', edgecolor='black', boxstyle='round,pad=0.5', alpha=0.5))
        elif city == 'Foshanshi':
            ax.text(lon - 2.5, lat, city[:-3], color='k', fontsize=12, transform=ccrs.PlateCarree(),
                    bbox=dict(facecolor='white', edgecolor='black', boxstyle='round,pad=0.5', alpha=0.5))
        elif city == 'Dongguanshi':
            ax.text(lon + 0.5, lat, city[:-3], color='k', fontsize=12, transform=ccrs.PlateCarree(),
                    bbox=dict(facecolor='white', edgecolor='black', boxstyle='round,pad=0.5', alpha=0.5))
        elif city == 'Shenzhenshi':
            ax.text(lon + 0.5, lat-0.5, city[:-3], color='k', fontsize=12, transform=ccrs.PlateCarree(),
                    bbox=dict(facecolor='white', edgecolor='black', boxstyle='round,pad=0.5', alpha=0.5))
        elif city == 'Tianjinshi':
            ax.text(lon + 0.5, lat, city[:-3], color='k', fontsize=12, transform=ccrs.PlateCarree(),
                    bbox=dict(facecolor='white', edgecolor='black', boxstyle='round,pad=0.5', alpha=0.5))
        elif city == 'Haerbinshi':
            ax.text(lon-1, lat+1, 'Harbin', color='k', fontsize=12, transform=ccrs.PlateCarree(),
                    bbox=dict(facecolor='white', edgecolor='black', boxstyle='round,pad=0.5', alpha=0.5))
        elif city == 'Xianshi':
            ax.text(lon-1, lat+0.5, 'Xi\'an', color='k', fontsize=12, transform=ccrs.PlateCarree(),
                    bbox=dict(facecolor='white', edgecolor='black', boxstyle='round,pad=0.5', alpha=0.5))
        else:
           ax.text(lon-1, lat+0.5, city[:-3], color='k', fontsize=12, transform=ccrs.PlateCarree(),
                   bbox=dict(facecolor='white', edgecolor='black', boxstyle='round,pad=0.5', alpha=0.5))

    plt.savefig(r'D:\LW\ABM\OutputData\Result\pic\map_21Cities.png', dpi=300)
    plt.savefig(r'D:\LW\ABM\OutputData\Result\pic\map_21Cities.pdf')
    # plt.show()
