# Python 3.9
# 绘制spatial pattern的图

import os
import geopandas as gpd
import pandas as pd
import matplotlib.pyplot as plt
import numpy as np
import contextily as ctx
from matplotlib.lines import Line2D

plt.rcParams['pdf.fonttype'] = 42

def drow_the_scale(ax, length_cm=2, lw=2):
    """
    画固定物理长度的比例尺，并根据投影坐标系计算实际距离（以整数公里显示）
    ax: Matplotlib 的 Axes 对象
    length_cm: 比例尺的物理长度，单位为厘米（默认 2 cm）
    lw: 比例尺线条的宽度
    """
    # 获取当前图形的分辨率和尺寸（单位：英寸）
    fig = ax.get_figure()
    dpi = fig.dpi  # 获取每英寸的点数
    length_inch = length_cm / 2.54  # 将厘米转换为英寸
    length_pixel = length_inch * dpi  # 将英寸转换为像素

    # 将像素长度转换为数据坐标系长度
    xlim = ax.get_xlim()
    ylim = ax.get_ylim()
    x_range = xlim[1] - xlim[0]  # x 轴数据范围
    bbox = ax.get_window_extent().transformed(fig.dpi_scale_trans.inverted())  # 获取轴的边界框，单位为英寸
    x_length_data = (length_pixel / bbox.width) * x_range  # 计算出比例尺在数据坐标系中的长度

    # 设置比例尺在图形中的位置
    x_start = xlim[0] + 0.05 * x_range  # 将比例尺的 x 起点距离左边调整为 3%
    y_pos = ylim[0] + 0.02 * (ylim[1] - ylim[0])  # 调整 y 轴位置，距离底部 2%

    # 计算比例尺在 EPSG:3395 投影坐标系中的实际距离
    actual_distance_meters = x_length_data  # 投影坐标系的单位是米
    actual_distance_km = actual_distance_meters / 1000  # 转换为公里

    # 将实际距离四舍五入为最近的整数
    rounded_distance_km = np.round(actual_distance_km)

    # 调整图上比例尺的长度，使实际距离为整数公里
    scale_adjustment_factor = rounded_distance_km / actual_distance_km
    x_length_data_adjusted = x_length_data * scale_adjustment_factor  # 调整后的图上距离

    # 画比例尺
    ax.hlines(y=y_pos, xmin=x_start, xmax=x_start + x_length_data_adjusted, colors="black", lw=lw)

    # 在比例尺两端画刻度线
    ax.vlines(x=x_start, ymin=y_pos - lw / 200, ymax=y_pos + lw / 200, colors="black", lw=1)
    ax.vlines(x=x_start + x_length_data_adjusted, ymin=y_pos - lw / 200, ymax=y_pos + lw / 200, colors="black", lw=1)

    # 添加比例尺的实际整数距离
    ax.text(x_start + x_length_data_adjusted / 2, y_pos + lw / 100 * 40000, f'{int(rounded_distance_km)} km', ha='center', va='bottom',
            fontsize=11)
    # 移除框线和坐标轴
    ax.set_axis_off()


def process_city_data(city, city_en, shp_path, city_path):
    """
    处理单个城市的数据，包括合并shp和csv，生成color列，并绘制地图和比例尺。
    """
    # 找到shapefile和csv文件

    shp = os.path.join(shp_path, f"{city}_grid.shp")
    boundary_shp = os.path.join(shp_path, f"{city}.shp")
    county_shp = os.path.join(shp_path, f"{city}_county.shp")

    csv_file_dif = os.path.join(city_path, "sa_deficit.csv")
    csv_file_sur = os.path.join(city_path, "sa_surplus.csv")

    # 读取shapefile和csv文件
    gdf = gpd.read_file(shp)
    boundary_shp_gdf = gpd.read_file(boundary_shp)
    county_shp_gdf = gpd.read_file(county_shp)

    # 确保投影为EPSG:3395
    sr_code = 3857
    gdf = gdf.to_crs(epsg=sr_code)
    boundary_shp_gdf = boundary_shp_gdf.to_crs(epsg=sr_code)
    county_shp_gdf = county_shp_gdf.to_crs(epsg=sr_code)

    df1 = pd.read_csv(csv_file_dif)[['Tid', 'PP_VAL']]
    df2 = pd.read_csv(csv_file_sur)[['Tid', 'PP_VAL']]
    df = df1.merge(df2, on='Tid')   # merge会生成两列，分别是PP_VAL_x, PP_VAL_y
    df = df.fillna(0)
    # 根据要求处理csv文件并生成colorma列
    def assign_color(row):
        if 0 < row['PP_VAL_x'] <= 0.01:
            return 'Deficit (p = 0.01)'
        elif 0.01 < row['PP_VAL_x'] <= 0.05:
            return 'Deficit (p = 0.05)'
        elif 0.05 < row['PP_VAL_x'] <= 0.1:
            return 'Deficit (p = 0.1)'
        elif 0 < row['PP_VAL_y'] <= 0.01:
            return 'Surplus (p = 0.01)'
        elif 0.01 < row['PP_VAL_y'] <= 0.05:
            return 'Surplus (p = 0.05)'
        elif 0.05 < row['PP_VAL_y'] <= 0.1:
            return 'Surplus (p = 0.1)'
        else:
            return 'Not Significant'

    df['colorma'] = df.apply(assign_color, axis=1)
    print('city:', city_en)
    print('Deficit (p = 0.01)', round(len(df[df['colorma'] == 'Deficit (p = 0.01)']) / len(df) * 100, 2), '%')
    print('Deficit (p = 0.05)', round(len(df[df['colorma'] == 'Deficit (p = 0.05)']) / len(df) * 100, 2), '%')
    print('Deficit (p = 0.1)', round(len(df[df['colorma'] == 'Deficit (p = 0.1)']) / len(df) * 100, 2), '%')
    print('Surplus (p = 0.01)', round(len(df[df['colorma'] == 'Surplus (p = 0.01)']) / len(df) * 100, 2), '%')
    print('Surplus (p = 0.05)', round(len(df[df['colorma'] == 'Surplus (p = 0.05)']) / len(df) * 100, 2), '%')
    print('Surplus (p = 0.1)', round(len(df[df['colorma'] == 'Surplus (p = 0.1)']) / len(df) * 100, 2), '%')
    print('-' * 20)

    # 合并shapefile和csv文件，基于Tid列
    merged_gdf = gdf.merge(df, on='Tid')

    # 自定义颜色映射
    color_map = {
        'Not Significant': 'white', # '#CCCCCC' # '#FEFCFC'   # other cases
        'Deficit (p = 0.01)': '#6999BC',
        'Deficit (p = 0.05)': '#6DBBB9',
        'Deficit (p = 0.1)': '#9CD1BF',
        'Surplus (p = 0.01)': '#D35177',
        'Surplus (p = 0.05)': '#F38C73',
        'Surplus (p = 0.1)': '#F9C5A0'
    }

    # 使用map转换为颜色
    merged_gdf['color'] = merged_gdf['colorma'].map(color_map)

    # 创建城市的绘图
    fig, ax = plt.subplots(figsize=(10, 6))

    # 绘制城市网格地图，使用自定义颜色
    merged_gdf.plot(ax=ax, color=merged_gdf['color'], edgecolor='#CCCCCC', linewidth=0.01)
    boundary_shp_gdf.plot(ax=ax, edgecolor='k', facecolor='none', linewidth=0.5)  # 绘制边界
    # county_shp_gdf.plot(ax=ax, edgecolor='k', facecolor='none', alpha=0.6, linewidth=2)  # 绘制边界

    # 添加底图
    # ctx.add_basemap(ax, source='http://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png')  # 可选择不同的底图来源

    # 统计每种颜色的数量
    color_props = {}
    for key in color_map.keys():
        color_props[key] = len(merged_gdf[merged_gdf['colorma'] == key]) / len(merged_gdf) * 100

    # 添加图例
    legend_labels = []
    for label, prop in color_props.items():
        legend_labels.append(f'{label}: {round(prop, 2)}%')

    # 创建自定义图例
    legend_elements = [Line2D([0], [0], marker='s', markersize=8, color='w', markerfacecolor=color, markeredgecolor='#CCCCCC',
                              markeredgewidth=0.1, label=label)
                       for color, label in zip(color_map.values(), legend_labels)]

    # ax.legend(handles=legend_elements, loc='upper left', handletextpad=0.5, fontsize=9)

    # 添加比例尺
    drow_the_scale(ax, length_cm=0.02)

    plt.title(city_en, fontsize=16)

    # 保存图像为 PDF，使用城市名作为文件名
    plt.savefig(f'D:\\LW\\ABM\\OutputData\\Result\\pic\\sigma=1\\Inflow\\NumPerShelter\\bySpatialPattern\\PDF\\{city_en}.pdf')
    plt.savefig(f'D:\\LW\\ABM\\OutputData\\Result\\pic\\sigma=1\\Inflow\\NumPerShelter\\bySpatialPattern\\PNG\\{city_en}.png', dpi=300)
    print(city_en, ' done.')
    plt.close()


if __name__ == '__main__':
    path = 'D:/LW/ABM'
    outputPath = path + '/OutputData'

    sigma = 1

    relation = pd.read_csv(outputPath + '/cities_21/' + 'cities21_pop_CH.csv', header=None, usecols=[0, 3], encoding='gbk')
    cities_cn = relation[0].tolist()
    cities_en = relation[3].tolist()

    del relation

    for i in range(len(cities_cn)):
        cities_en[i] = cities_en[i][:-3]
        if cities_en[i] == 'xian':
            cities_en[i] = 'xi\'an'
        if cities_en[i] == 'haerbin':
            cities_en[i] = 'harbin'
        city = cities_cn[i]

        basePath = outputPath + '/Result/cities_21_max/' + city
        storagePath = outputPath + '/Result/cities_21_max/' + city + '/sigma=' + str(sigma)
        pic_storagePath = basePath + '/pic/sigma=' + str(sigma)
        shp_path = outputPath + '/cities_21/' + city
        shp = gpd.read_file(shp_path)

        process_city_data(city, cities_en[i].capitalize(), shp_path, storagePath)
        # break


